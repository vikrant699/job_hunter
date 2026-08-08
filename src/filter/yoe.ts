// src/filter/yoe.ts — deterministic "how many years does this JD ask for?".
//
// Runs BEFORE the gate. The profile already carries a hard deal-breaker for
// "minimum 7+ years", but that rule lived only in the prompt, so it cost an LLM
// call to apply and was subject to the model noticing the line at all. When the
// JD states the bar in plain text, a regex settles it for free.
//
// This only ever answers "what is the smallest number of years this JD asks
// for". Whether that disqualifies the role is the caller's policy decision.

/** Below/above these, a "N years" match is not a candidate-experience figure. */
const MIN_PLAUSIBLE_YEARS = 1;
const MAX_PLAUSIBLE_YEARS = 25;

/**
 * Phrases where a number followed by "years" is NOT the candidate's required
 * experience. Checked against the text immediately around the match, because
 * every one of these appears in real postings near the word "years".
 */
const NOT_EXPERIENCE_RE = /\b(?:of age|old|in business|since|founded|established|anniversary|warranty|tenure)\b/i;

/**
 * A number that introduces a requirement, in the shapes JDs actually use:
 *   "8+ years", "5 + years", "7 yrs+", "minimum 7 years", "at least 6 years",
 *   "3-5 years", "8 to 10 years", "between 4 and 7 years"
 * The trailing "year(s)"/"yr(s)" is mandatory — a bare number is never a match,
 * which is what keeps team sizes and salary bands out.
 */
const YEARS_RE =
  /(?:(?:minimum|min\.?|at least|over|more than)\s+)?(\d{1,2})\s*(?:\+\s*)?(?:(?:-|–|to|and)\s*\d{1,2}\s*)?(?:\+\s*)?(?:years?|yrs?)\s*\+?/gi;

/**
 * The smallest number of years this JD asks for, or null when it never says.
 *
 * The SMALLEST, deliberately: a JD listing "3+ years of software development" and
 * "2+ years of architecture" is stating two separate requirements, not a 5-year
 * bar, and one saying "10+ years leading teams; 4+ years coding" is reachable by
 * a 4-year engineer. Taking the max would silently drop those. Under-rejecting
 * costs a single gate call; over-rejecting loses the posting entirely, and the
 * caller never finds out.
 */
export function parseStatedYoeMin(jdText: string): number | null {
  let smallest: number | null = null;
  for (const match of jdText.matchAll(YEARS_RE)) {
    const years = Number(match[1]);
    if (!Number.isInteger(years) || years < MIN_PLAUSIBLE_YEARS || years > MAX_PLAUSIBLE_YEARS) {
      continue;
    }
    // Look at the surrounding words, not just the match, so "18 years of age"
    // and "in business for 30 years" are excluded.
    const at = match.index;
    const context = jdText.slice(Math.max(0, at - 40), at + match[0].length + 25);
    if (NOT_EXPERIENCE_RE.test(context)) continue;

    if (smallest === null || years < smallest) smallest = years;
  }
  return smallest;
}

/**
 * Does this JD's own stated entry bar put the role out of reach? Used as a
 * pre-gate skip, so it must only fire on an explicit statement — an unstated
 * requirement (null) is never a rejection.
 */
export function exceedsYoeCap(jdText: string, hardYoeCap: number): boolean {
  const stated = parseStatedYoeMin(jdText);
  return stated !== null && stated >= hardYoeCap;
}
