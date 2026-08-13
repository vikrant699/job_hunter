// Detects JD text that is technically non-empty but carries no information —
// vendor placeholders an employer never replaced, or junk so short the gate
// would be scoring noise. Found live (2026-08-13 sweep): Darwinbox's
// "Please enter job description" (bigbasket, unacademy), RippleHire's
// "Please update the Job Description" (axissecurities), and Zepto postings
// whose whole JD is a row of dots. A junk JD is reclassified to the no-jd
// drop stage instead of being sent to the LLM as if it were content.

const PLACEHOLDER_RES: readonly RegExp[] = [
  /^please (enter|update) (the )?job description\.?$/i,
  /^(job )?description( goes)? here\.?$/i,
  /^(tbd|tba|na|n\/a)\.?$/i,
  /^attached\.?$/i, // "JD attached [as a PDF we cannot see]" — navi
  /^(lorem ipsum)\b/i,
  /^sample data\.?$/i,
];

/** True when the trimmed JD is a known placeholder or content-free junk. */
export function isJunkJd(jdText: string): boolean {
  const t = jdText.trim();
  if (t === "") return false; // empty is the caller's existing no-jd path
  // All punctuation/whitespace (e.g. "....." dots-only JDs).
  if (!/[a-z0-9]/i.test(t)) return true;
  return PLACEHOLDER_RES.some((re) => re.test(t));
}
