import type { RecruiterRow } from "../db/recruiters.js";

/**
 * Legal-entity suffixes stripped as TRAILING tokens only (never mid-string).
 * Deliberately does NOT include "company"/"co": that word is too often part of
 * the actual brand name ("Bain & Company", "Daniel P. O'Reilly and Company")
 * rather than a legal suffix, and stripping it would collide unrelated firms
 * that happen to both end in "... and Company". The suffixes below are
 * unambiguous legal-entity markers with no such false-positive risk.
 */
const LEGAL_SUFFIXES = new Set([
  "pvt", "private", "ltd", "limited", "inc", "llc", "corp", "corporation",
]);

/**
 * Normalizes a company name for matching: lowercase, punctuation -> spaces,
 * trailing legal-suffix tokens stripped (repeatedly, so "Pvt Ltd" strips both),
 * whitespace collapsed. Pure and idempotent.
 */
export function normalizeCompanyName(s: string): string {
  const lowered = s.toLowerCase();
  // Strip all punctuation (anything not a letter/digit/whitespace) to spaces.
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
  /** Returns the ISO timestamp of the last draft to this email (for any/all
   *  profiles the caller wants considered), or null if never drafted. */
  lastDraftedAt: (email: string) => string | null;
  nowMs: number;
  cooldownDays: number;
}

export interface FindContactsResult {
  eligible: RecruiterRow[];
  ineligible: Array<{ recruiter: RecruiterRow; reason: IneligibleReason }>;
}

/** Registrable label extracted from an email's domain (part before the first
 *  dot), lowercased. "hr@adda247.com" -> "adda247". */
function domainLabel(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  const label = domain.split(".")[0];
  return label && label.length > 0 ? label : null;
}

// Guards the email-domain heuristic against short/common labels ("hr", "app")
// that would false-positive-match unrelated companies.
const MIN_DOMAIN_LABEL_LENGTH = 4;

// EXACT equality only. Substring containment (either direction) was tried and
// is dangerously loose against real data: a contact at @tech...com would have
// matched 41 registry companies ("Polygon Tech", "AgNext Technologies", ...),
// @india... 328, and short names matched the other way ("Axio" inside
// "axiomconsulting"). A wrong match here addresses a real recruiter about a
// company they have nothing to do with — worst failure mode this pipeline has —
// so the heuristic stays strict: "Adda247" <-> hr@adda247.com matches, nothing
// fuzzier does.
function domainHeuristicMatch(companyNormCollapsed: string, email: string): boolean {
  const label = domainLabel(email);
  if (!label || label.length < MIN_DOMAIN_LABEL_LENGTH) return false;
  return label === companyNormCollapsed;
}

/**
 * Finds recruiter contacts for a company name, trying match tiers in priority
 * order and stopping at the first tier that yields any matches:
 *   a) exact normalized company name match
 *   b) normalized alt-name match (';'-joined on the candidate row)
 *   c) email-domain heuristic (collapsed name === domain label, exact)
 * Matches are then split into eligible / ineligible (bounced contact status,
 * or drafted within the cooldown window) and eligible ones are ordered
 * verified-first, then least-recently-drafted first (never-drafted = first).
 */
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
