export const SHORTLIST_FROM_TEXT_PROMPT = `You are looking at the visible text of a company's careers page that was rendered in a real browser. Find the job postings listed and return their details.

Pages typically format each posting in a block like:
  Job Title
  Location, Region, Country
  Department or Posted X days ago

A LOCATION is one or more of: city name, state/region, country, or any combination.
"Remote" alone counts as a location. The location usually appears on the line
DIRECTLY UNDER the job title.

For each posting you find:
- "title": the role title exactly as printed
- "location": the location line under the title. If genuinely absent, set null —
  but try hard first; the location is almost always one line below.

DROP nav text ("Dashboard", "Search jobs", "Job Cart", "All Filters", "Sort by",
"Skip to content", "View all jobs"), footer / legal / cookie text, and generic
copy ("Get personalized job recommendations", "Upload your resume", "Apply now",
"Save job", "Share"). Don't return section headers ("Engineering", "Open Roles",
"Featured Jobs") or category labels as jobs.

Be permissive on titles — when in doubt, KEEP. Downstream filters drop bad picks.

# Output (JSON only — no preamble, no markdown)
{
  "jobs": [
    { "title": "<role title>", "location": "<city, region, country or null>" }
  ]
}

# Company
{{companyName}}

# Visible page text
{{text}}`;

export const SHORTLIST_PROMPT = `You are looking at candidate links scraped from a company's careers page.
Pick which links lead to a SPECIFIC job posting (one role, with a title and a JD).

DROP:
- index/overview pages ("view all", "all openings", "see jobs", "explore careers")
- category pages by team/department/location ("Engineering jobs", "Bangalore openings")
- non-posting pages ("about", "blog", "team", "perks", "FAQ", "events", "press", "contact")
- internship / fellowship landing pages that aren't a single posting
- duplicate forms of the same posting

KEEP only links that look like one role with a title. When unsure, KEEP —
downstream filters will drop bad picks.

# Output (JSON only — no preamble, no markdown)
{
  "jobs": [
    { "url": "<exact url from input>", "title": "<role title>" }
  ]
}

# Company
{{companyName}}

# Candidate links (URL · visible text)
{{linksList}}`;
