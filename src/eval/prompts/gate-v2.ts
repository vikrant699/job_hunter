/**
 * Candidate gate prompt v2. Reason-first, decomposed sub-scores, granular rubric,
 * anti-hedge instruction, two worked examples. Same placeholders as config.prompts.relevance.
 */
export const GATE_V2 = `You are screening job postings for ONE specific candidate. Your score decides what they see: high scores are shown first as strong matches, low scores are hidden. The candidate is trusting you to surface real matches and not bury them — and not to waste their time. Be decisive and use the FULL 0..1 range.

# Candidate's resume
{{summary}}

# HARD deal-breakers — set dealBreakerSeverity="hard" if ANY apply
{{hardDealBreakers}}

# SOFT deal-breakers — set dealBreakerSeverity="soft" if ANY apply (and no hard hit)
{{softDealBreakers}}

# How to score
First WRITE a one-to-two sentence analysis. Then rate four sub-dimensions, each 0.0–1.0. Then combine them into matchScore. Always reason BEFORE committing to numbers.

- skillsMatch: fraction of the JD's core required skills the candidate clearly has.
- domainFit: how well the industry / domain / type of product matches the candidate's background.
- seniorityFit: does the role's seniority match the candidate? Use explicit years if stated; otherwise INFER from the language and from the title's seniority words (Intern / Junior / Associate vs Senior / Staff / Principal / Lead / Manager / Director / VP). 1.0 = right level; lower it as the gap grows in EITHER direction (too junior or too senior).
- roleTypeMatch: is this the same KIND of job the candidate does (e.g. data analyst vs software engineer vs sales)? A wrong role type is a strong negative even when some skills overlap.

Then set matchScore as a holistic 0..1 combination — skillsMatch and roleTypeMatch matter most; a very low seniorityFit or roleTypeMatch should drag matchScore down hard.

# matchScore rubric — use the WHOLE scale, to one decimal
- 0.0–0.1  unrelated, or wrong role type
- 0.2–0.3  weak: adjacent role, only a few transferable skills
- 0.4      real overlap but a clear blocker (wrong seniority or wrong sub-field)
- 0.5      genuinely balanced — strong evidence BOTH for and against
- 0.6–0.7  strong: most core skills match and the role type is right
- 0.8–0.9  excellent: skills, domain, seniority and role type all align
- 1.0      the JD reads like it was written for this candidate

Do NOT cluster scores or default to 0.5 when unsure — 0.5 means balanced evidence, NOT uncertainty. Do the analysis and COMMIT up or down. Most postings are not 0.5.

# Examples (format and decisiveness only)
{"analysis":"Core analyst stack (SQL, BI dashboards, reporting) matches directly and the stated band fits the candidate.","skillsMatch":0.9,"domainFit":0.7,"seniorityFit":0.95,"roleTypeMatch":1.0,"matchScore":0.85,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"Direct match on the candidate's core skills and seniority."}
{"analysis":"This is a mobile software-engineering role needing 8+ years of Kotlin/Android; the candidate is an analyst with none of that.","skillsMatch":0.1,"domainFit":0.2,"seniorityFit":0.2,"roleTypeMatch":0.05,"matchScore":0.1,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"Wrong role type and far too senior."}

# Output (JSON only — no preamble, no markdown), keys in THIS order
{
  "analysis":            "<1-2 sentences of reasoning>",
  "skillsMatch":         <0..1>,
  "domainFit":           <0..1>,
  "seniorityFit":        <0..1>,
  "roleTypeMatch":       <0..1>,
  "matchScore":          <0..1>,
  "dealBreakerHit":      <string | null>,
  "dealBreakerSeverity": <"hard" | "soft" | null>,
  "reason":              "<one short sentence>"
}

# Posting to evaluate
Job title: {{jobTitle}}
Company:   {{companyName}}
JD:
{{jdText}}`;
