// Deterministic "how many years does this JD ask for?" - settles the common case by regex instead of an LLM call.

/** Below/above these, a "N years" match is not a candidate-experience figure. */
const MIN_PLAUSIBLE_YEARS = 1;
const MAX_PLAUSIBLE_YEARS = 25;

/** Phrases where a number followed by "years" is NOT the candidate's required experience. */
const NOT_EXPERIENCE_RE = /\b(?:of age|old|in business|since|founded|established|anniversary|warranty|tenure)\b/i;

/** Matches "8+ years", "minimum 7 years", "3-5 years", etc; the trailing year(s)/yr(s) is mandatory so bare numbers (team sizes, salary bands) never match. */
const YEARS_RE =
  /(?:(?:minimum|min\.?|at least|over|more than)\s+)?(\d{1,2})\s*(?:\+\s*)?(?:(?:-|–|to|and)\s*\d{1,2}\s*)?(?:\+\s*)?(?:years?|yrs?)\s*\+?/gi;

/** Smallest stated years requirement, or null if unstated - deliberately the min, since a JD listing several separate requirements (not a stacked bar) shouldn't over-reject. */
export function parseStatedYoeMin(jdText: string): number | null {
  let smallest: number | null = null;
  for (const match of jdText.matchAll(YEARS_RE)) {
    const years = Number(match[1]);
    if (!Number.isInteger(years) || years < MIN_PLAUSIBLE_YEARS || years > MAX_PLAUSIBLE_YEARS) {
      continue;
    }
    // Check words around the match, not just the match, to exclude "18 years of age" etc.
    const at = match.index;
    const context = jdText.slice(Math.max(0, at - 40), at + match[0].length + 25);
    if (NOT_EXPERIENCE_RE.test(context)) continue;

    if (smallest === null || years < smallest) smallest = years;
  }
  return smallest;
}

/** Only fires on an explicit statement - an unstated requirement (null) is never a rejection. */
export function exceedsYoeCap(jdText: string, hardYoeCap: number): boolean {
  const stated = parseStatedYoeMin(jdText);
  return stated !== null && stated >= hardYoeCap;
}
