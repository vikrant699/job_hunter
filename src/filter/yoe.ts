const MIN_PLAUSIBLE_YEARS = 1;
const MAX_PLAUSIBLE_YEARS = 25;

const NOT_EXPERIENCE_RE = /\b(?:of age|old|in business|since|founded|established|anniversary|warranty|tenure)\b/i;

/** The trailing year(s)/yr(s) is mandatory so bare numbers (team sizes, salary bands) never match. */
const YEARS_RE =
  /(?:(?:minimum|min\.?|at least|over|more than)\s+)?(\d{1,2})\s*(?:\+\s*)?(?:(?:-|–|to|and)\s*\d{1,2}\s*)?(?:\+\s*)?(?:years?|yrs?)\s*\+?/gi;

/** Deliberately the min: a JD listing several separate requirements (not a stacked bar) shouldn't over-reject. */
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

export function exceedsYoeCap(jdText: string, hardYoeCap: number): boolean {
  const stated = parseStatedYoeMin(jdText);
  return stated !== null && stated >= hardYoeCap;
}
