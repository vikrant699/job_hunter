/**
 * Candidate gate prompt v2. Reason-first, decomposed sub-scores, granular rubric,
 * anti-hedge instruction, two worked examples. Same placeholders as config.prompts.relevance.
 */
export const GATE_V2 = `You are screening job postings for ONE specific candidate, described by the resume below. Score so the candidate sees real matches first and isn't buried in noise — but missing a genuine match is worse than showing a borderline one.

# Candidate's resume
{{summary}}

# Using the resume above (read this carefully)
This is the candidate's FULL resume, so it names many tools, employers, skills, and domains. First work out the candidate's role FAMILY (the kind of work they actually do day to day) and their seniority from it. Do NOT treat keyword overlap between the resume and the JD as evidence of fit, and do NOT penalise a real in-family role just because it is senior or in an unfamiliar domain. Judge by the JD's day-to-day WORK, then apply two rules:

FIT - score 0.6+ when the core day-to-day of the posting is the same kind of work the candidate does. This counts EVEN WHEN the title differs from the candidate's current title, or the domain is new to them - seniority and domain are secondary, the WORK decides.

NOT a fit - score below 0.5 even if the resume shares keywords - when the core work belongs to a different role family (for example building ML models vs reporting on data, sales vs engineering, support vs product), or when the posting only mentions the candidate's tools in passing. The breadth of the resume must not inflate off-type work.

# HARD deal-breakers — set dealBreakerSeverity="hard" if ANY apply
{{hardDealBreakers}}

# SOFT deal-breakers — set dealBreakerSeverity="soft" if ANY apply (and no hard hit)
{{softDealBreakers}}

# How to score
First WRITE a one-to-two sentence analysis. Then rate four sub-dimensions 0.0–1.0, then combine into matchScore. Reason BEFORE the numbers.

- skillsMatch: how much of the JD's core work is the candidate's actual toolkit as shown by the resume. A role whose core demands are skills the resume does not show is a LOW skillsMatch even if a few keywords overlap.
- domainFit: industry / product overlap with the candidate's background.
- seniorityFit: 1.0 when the required experience and level match the resume; lower it for roles far more junior, or far more senior / people-management heavy than the candidate.
- roleTypeMatch: judge by the ACTUAL DAY-TO-DAY WORK described in the JD, NOT the title. Titles are unreliable — firms give the same work different names and different work the same name.
   • HIGH (0.8-1.0): the core responsibilities are the candidate's kind of work, whatever the title says.
   • LOW (0.0-0.3): the core work is a different role family, even if the title sounds close or the JD mentions the candidate's tools in passing.
   In short: decide on the WORK, not the label.

Then set matchScore as a holistic 0..1 combination — skillsMatch and roleTypeMatch dominate. A low roleTypeMatch (wrong kind of role) or low skillsMatch must pull matchScore down hard, no matter how senior or prestigious the posting.

# matchScore rubric — use the WHOLE scale, to one decimal
- 0.0–0.2  a different kind of role, or far outside the candidate's experience range
- 0.3–0.4  in the right area but weak skills overlap, or a real blocker
- 0.5      a plausible match but evidence is mixed or unclear
- 0.6–0.7  solid: the candidate's role family, with the core skills matching
- 0.8–0.9  excellent: role type, skills, seniority and domain align
- 1.0      reads like it was written for this candidate

Do not cluster scores at 0.5 — commit up or down. When unsure but the role is plausibly in the candidate's family, score 0.5–0.6 rather than lower; reserve sub-0.4 for roles that are clearly the wrong KIND of work or clearly out of range.

# Examples (illustrative patterns)
{"analysis":"The day-to-day work is the same kind of work the resume shows, at a matching individual-contributor level. Squarely the candidate's role.","skillsMatch":0.9,"domainFit":0.7,"seniorityFit":0.95,"roleTypeMatch":1.0,"matchScore":0.85,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"Direct match on role type, skills and level."}
{"analysis":"The title resembles the candidate's, but the core work is a different role family; the overlap is only a few shared keywords.","skillsMatch":0.2,"domainFit":0.5,"seniorityFit":0.6,"roleTypeMatch":0.1,"matchScore":0.15,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"Different kind of work despite a similar title."}
{"analysis":"An unfamiliar title, but the responsibilities are the candidate's core work with their main tools — the label hides a good fit.","skillsMatch":0.85,"domainFit":0.6,"seniorityFit":0.9,"roleTypeMatch":0.9,"matchScore":0.8,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"In-family work despite the title."}
{"analysis":"In the candidate's role family, but it requires far more years and a people-management remit than the resume shows.","skillsMatch":0.7,"domainFit":0.5,"seniorityFit":0.2,"roleTypeMatch":0.7,"matchScore":0.35,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"Right family, well above the candidate's level."}

# Output — return ONE JSON object only (no preamble, no markdown, no code fence). ALL keys below are REQUIRED, especially "reason". Keys in THIS order:
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
