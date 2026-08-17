// Detects JD text that is non-empty but carries no information (vendor placeholders, dots-only junk) and routes it to the no-jd drop stage instead of the LLM.

const PLACEHOLDER_RES: readonly RegExp[] = [
  /^please (enter|update) (the )?job description\.?$/i,
  /^(job )?description( goes)? here\.?$/i,
  /^(tbd|tba|na|n\/a)\.?$/i,
  /^attached\.?$/i, // PDF-only JD, text not visible
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
