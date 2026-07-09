// src/blast/pool.ts
//
// Ordered pool of not-yet-processed candidates from the Raw Data tab. Email
// splitting/normalization mirrors src/outreach/contacts.ts but is duplicated
// on purpose: the blast tool must stay deletable without touching outreach.
export interface BlastCandidate {
  email: string;
  company: string;
  contactName: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_REPLY_RE = /^(?:no-?reply|do-?not-?reply|donotreply)@/i;

/** `rawRows` is the full tab including the header row (row 0 is skipped).
 *  Live column layout: A company, B email(s), C contact name. */
export function buildPool(rawRows: string[][], known: ReadonlySet<string>): BlastCandidate[] {
  const seen = new Set<string>();
  const pool: BlastCandidate[] = [];
  for (const row of rawRows.slice(1)) {
    const company = (row[0] ?? "").trim();
    const contactName = (row[2] ?? "").trim() || null;
    const emails = (row[1] ?? "")
      .split(/[/,]/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e));
    for (const email of emails) {
      if (NO_REPLY_RE.test(email)) continue;
      if (seen.has(email) || known.has(email)) continue;
      seen.add(email);
      pool.push({ email, company, contactName });
    }
  }
  return pool;
}
