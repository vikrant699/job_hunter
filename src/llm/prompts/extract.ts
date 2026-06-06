export const EXTRACT_PROMPT = `From the JD below, extract the minimum and maximum years of experience required.

Rules:
- "3-5 years"      → yoeMin=3, yoeMax=5
- "5+ years"       → yoeMin=5, yoeMax=null
- "up to 6 years"  → yoeMin=null, yoeMax=6
- If unstated or only soft phrasing ("experienced"), return null for both.
- Never invent values.

# Output (JSON only — no preamble, no markdown)
{
  "yoeMin": <number | null>,
  "yoeMax": <number | null>
}

# JD
{{jdText}}`;
