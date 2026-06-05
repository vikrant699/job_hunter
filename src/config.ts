/**
 * Application config — runtime knobs that aren't user-specific.
 *
 * Personal stuff (your resume, deal-breakers, target locations, title-deny
 * patterns, services denylist) lives in `config/profile.ts` instead.
 */
import { RELEVANCE_PROMPT } from "./llm/relevance.js";

export const config = {
  fetch: {
    /** How many companies of one provider run in parallel. */
    concurrencyPerProvider: 4,
    /** Postings processed in parallel inside one company. HTTP fans out;
     *  Ollama serializes via the semaphore in llm/client.ts. */
    workersPerCompany: 5,
    /** Politeness delay between worker-pool iterations within a company. */
    interCallDelayMs: 250,
    /** Per-call timeout for ATS fetches. */
    timeoutMs: 20_000,
    /** Identify ourselves to ATS providers; some block default node UA. */
    userAgent: "job-hunter-bot/0.1",
  },

  llm: {
    ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    // qwen3.5:9b (Q4_K_M, ~6.6GB, 256K-capable ctx). Switched 2026-06-05 from
    // qwen3:8b (which had beaten 7B/9B on a 236-posting reviewer-label replay —
    // AUC 0.78, 85% recall). think:false in the client keeps reasoning models
    // from emitting reasoning tokens. Pull once: `ollama pull qwen3.5:9b`.
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
    /** Timeout starts AFTER the semaphore slot is acquired, so it measures
     *  actual generation time (not queue wait). */
    timeoutMs: 90_000,
    maxRetries: 2,
    /** Ollama serializes on the GPU; only raise this if you run multiple
     *  Ollama instances behind a load balancer. */
    maxConcurrent: 1,
    /** Context window (tokens) per request. The KV cache grows linearly with this
     *  and must fit alongside the ~6.6GB qwen3.5:9b weights in 8GB VRAM, so we cap
     *  it at 9000 (down from 16384). Pair with OLLAMA_FLASH_ATTENTION=1 +
     *  OLLAMA_KV_CACHE_TYPE=q8_0 so the quantized KV cache fits. JD_MAX_CHARS in
     *  gate.ts is sized to THIS value — keep them in sync. Ollama defaults to 4096. */
    numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 9000),
  },

  prompts: {
    relevance: RELEVANCE_PROMPT,

    shortlistFromText: `You are looking at the visible text of a company's careers page that was rendered in a real browser. Find the job postings listed and return their details.

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
{{text}}`,

    shortlist: `You are looking at candidate links scraped from a company's careers page.
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
{{linksList}}`,

    extract: `From the JD below, extract the minimum and maximum years of experience required.

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
{{jdText}}`,
  },

  storage: {
    dbPath: "data/job_hunter.db",
    registryPath: "config/companies.json",
    postingRetentionDays: 90,
  },

  discord: {
    embedDescriptionMaxChars: 300,
    /** Prefix on every embed title — useful when sharing a channel with other bots. */
    titlePrefix: "[job-hunter]",
  },

  discovery: {
    /** Cap on new companies added per discovery run. Prevents a viral funding
     *  day or overly-broad query from flooding the registry. */
    maxAdditionsPerRun: 50,
    /** Don't add anything older than this. */
    rssMaxArticleAgeDays: 14,
    /** Hosts to skip — aggregators, content sites, salary-blog SEO farms. */
    skipHosts: [
      "linkedin.com", "indeed.com", "naukri.com", "glassdoor.com", "glassdoor.co.in",
      "monster.com", "ziprecruiter.com", "simplyhired.com", "ambitionbox.com",
      "shine.com", "timesjobs.com", "instahyre.com", "hirist.com", "iimjobs.com",
      "foundit.in", "wellfound.com", "angel.co", "builtin.com",
      "unojobs.com", "freshersworld.com", "joberge.com", "jobsforher.com",
      "jobaaj.com", "hireperfect.com", "jooble.org", "talent.com",
      "lsvp.com", "sequoiacap.com", "a16z.com", "accel.com",
      "kleinerperkins.com", "ycombinator.com",
      "youtube.com", "facebook.com", "twitter.com", "x.com", "instagram.com",
      "github.com", "medium.com", "substack.com", "reddit.com", "quora.com",
      "wikipedia.org", "crunchbase.com", "tracxn.com", "owler.com",
      "timesofindia.indiatimes.com", "indiatimes.com", "ndtv.com", "yourstory.com",
      "inc42.com", "entrackr.com", "moneycontrol.com", "livemint.com",
      "upgrad.com", "guvi.in", "igmguru.com", "excelgoodies.in", "edureka.co",
      "simplilearn.com", "intellipaat.com", "datacamp.com", "kaggle.com",
      "riadataanalytics.com", "growai.in", "analyticsvidhya.com",
      "geeksforgeeks.org", "tutorialspoint.com", "javatpoint.com",
    ],
    brave: {
      monthlyCap: 1000,
      monthlyBuffer: 50,
      queriesPerRun: 8,
      /** Rotating queries — daily run picks `queriesPerRun` by hash-of-date.
       *  Tune for your region and target role family. */
      queryPool: [
        'site:boards.greenhouse.io "India"',
        'site:boards.greenhouse.io "Bangalore"',
        'site:boards.greenhouse.io "Bengaluru"',
        'site:boards.greenhouse.io "Mumbai" "analyst"',
        'site:boards.greenhouse.io "analyst" "India"',
        'site:job-boards.greenhouse.io "India"',
        'site:jobs.lever.co "India"',
        'site:jobs.lever.co "Bangalore"',
        'site:jobs.lever.co "Bengaluru" "analyst"',
        'site:jobs.ashbyhq.com "India"',
        'site:jobs.ashbyhq.com "Bangalore"',
        'site:careers.smartrecruiters.com "India"',
        'site:jobs.smartrecruiters.com "Bangalore"',
        'site:myworkdayjobs.com "India" "analyst"',
        'site:myworkdayjobs.com "Bangalore" "analytics"',
        'site:myworkdayjobs.com "Mumbai" "analyst"',
        'site:eightfold.ai "Bangalore"',
        'site:eightfold.ai "India" "analyst"',
        'site:apply.workable.com "India"',
        'site:apply.workable.com "Bangalore"',
        'site:recruitee.com "India" "analyst"',
        'inurl:/careers "Bengaluru" "data analyst" -site:linkedin.com -site:naukri.com',
        'inurl:/careers "Pune" "business analyst" -site:linkedin.com -site:naukri.com',
        'inurl:/careers "Mumbai" "analyst" -site:linkedin.com -site:naukri.com',
        'inurl:/careers "Hyderabad" "analyst" -site:linkedin.com -site:naukri.com',
        'inurl:careers. "Bangalore" "analytics" -inurl:salary -inurl:blog -inurl:course',
        'inurl:jobs. "Bengaluru" "analyst" -inurl:salary -inurl:blog -inurl:course',
      ],
    },
    rss: {
      sources: [
        { name: "inc42-funding", url: "https://inc42.com/buzz/feed/" },
        { name: "yourstory-funding", url: "https://yourstory.com/category/funding/feed" },
      ],
    },
    yc: {
      directoryUrl: "https://www.ycombinator.com/companies?regions=India",
    },
  },
} as const;

export type Config = typeof config;
