import type { RecruiterRow } from "../db/recruiters.js";

// Trailing-token-only legal suffixes; deliberately excludes "company"/"co" since that's often part of the actual brand name ("Bain & Company") and would collide unrelated firms.
const LEGAL_SUFFIXES = new Set([
  "pvt", "private", "ltd", "limited", "inc", "llc", "corp", "corporation",
]);

/** Normalizes a company name for matching: lowercase, punctuation to spaces, trailing legal suffixes stripped repeatedly. */
export function normalizeCompanyName(s: string): string {
  const lowered = s.toLowerCase();
  const depunctuated = lowered.replace(/[^\p{L}\p{N}\s]/gu, " ");
  let tokens = depunctuated.split(/\s+/).filter((t) => t.length > 0);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? "")) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(" ");
}

export type IneligibleReason = "cooldown" | "bounced_contact";

export interface FindContactsInput {
  companyName: string;
  candidates: RecruiterRow[];
  /** ISO timestamp of the last draft to this email, or null if never drafted. */
  lastDraftedAt: (email: string) => string | null;
  nowMs: number;
  cooldownDays: number;
}

export interface FindContactsResult {
  eligible: RecruiterRow[];
  ineligible: Array<{ recruiter: RecruiterRow; reason: IneligibleReason }>;
}

/** Domain label before the first dot, lowercased. "hr@adda247.com" -> "adda247". */
function domainLabel(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  const label = domain.split(".")[0];
  return label && label.length > 0 ? label : null;
}

// Guards against short/common labels ("hr", "app") false-positive-matching unrelated companies.
const MIN_DOMAIN_LABEL_LENGTH = 4;

// EXACT equality only: substring containment was tried and matched dozens of unrelated companies (e.g. @tech...com to 41 registry rows) - misaddressing a recruiter is the worst failure mode here.
function domainHeuristicMatch(companyNormCollapsed: string, email: string): boolean {
  const label = domainLabel(email);
  if (!label || label.length < MIN_DOMAIN_LABEL_LENGTH) return false;
  return label === companyNormCollapsed;
}

// Match tiers in priority order, stopping at the first with any matches: (a) exact normalized name, (b) normalized alt-name, (c) domain heuristic; then splits eligible/ineligible (bounced, or drafted within cooldown) and sorts eligible verified-first, then least-recently-drafted first.
export function findContacts(input: FindContactsInput): FindContactsResult {
  const { companyName, candidates, lastDraftedAt, nowMs, cooldownDays } = input;
  const targetNorm = normalizeCompanyName(companyName);
  const targetCollapsed = targetNorm.replace(/\s+/g, "");

  const tierA = candidates.filter((c) => c.companyNorm === targetNorm);
  const tierB =
    tierA.length > 0
      ? []
      : candidates.filter((c) =>
          (c.altNamesNorm ?? "")
            .split(";")
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
            .includes(targetNorm),
        );
  const tierC =
    tierA.length > 0 || tierB.length > 0
      ? []
      : candidates.filter((c) => domainHeuristicMatch(targetCollapsed, c.email));

  const matched = tierA.length > 0 ? tierA : tierB.length > 0 ? tierB : tierC;

  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  const eligible: RecruiterRow[] = [];
  const ineligible: Array<{ recruiter: RecruiterRow; reason: IneligibleReason }> = [];

  for (const recruiter of matched) {
    if (recruiter.status === "bounced") {
      ineligible.push({ recruiter, reason: "bounced_contact" });
      continue;
    }
    const lastDraft = lastDraftedAt(recruiter.email);
    if (lastDraft !== null) {
      const elapsedMs = nowMs - new Date(lastDraft).getTime();
      if (elapsedMs < cooldownMs) {
        ineligible.push({ recruiter, reason: "cooldown" });
        continue;
      }
    }
    eligible.push(recruiter);
  }

  eligible.sort((a, b) => {
    const verifiedRank = (r: RecruiterRow): number => (r.status === "verified" ? 0 : 1);
    const rankDiff = verifiedRank(a) - verifiedRank(b);
    if (rankDiff !== 0) return rankDiff;

    const aLast = lastDraftedAt(a.email);
    const bLast = lastDraftedAt(b.email);
    if (aLast === null && bLast === null) return 0;
    if (aLast === null) return -1;
    if (bLast === null) return 1;
    return new Date(aLast).getTime() - new Date(bLast).getTime();
  });

  return { eligible, ineligible };
}
