# job-hunter-bot

A personal job-hunting bot. It pulls postings from a list of companies you care about,
filters them against your resume and deal-breakers, and pings the good matches to a
Discord channel.

You run it by hand with `npm run once` whenever you want a sweep. A single run takes
roughly 10 to 20 minutes for a registry of a few hundred companies, most of which is
waiting on the local LLM.

## What it needs

- Node 22 or newer (uses the built-in `node:sqlite`).
- [Ollama](https://ollama.com) running locally with a chat model pulled. The default is
  `qwen3.5:9b` (Q4_K_M, about 6.6 GB):
  ```
  ollama pull qwen3.5:9b
  ```
  On an 8 GB GPU it fits with a little CPU offload. Set `OLLAMA_FLASH_ATTENTION=1` and
  `OLLAMA_KV_CACHE_TYPE=q8_0` in Ollama's environment so the KV cache stays small. To
  use a different model, set `OLLAMA_MODEL` (and `OLLAMA_NUM_CTX` for the context size).
- Your resume as a PDF at `config/resume.pdf` (see Getting started).
- A Discord webhook URL (Channel settings, Integrations, Webhooks, New Webhook).
- Optionally, a [Brave Search](https://brave.com/search/api/) API key, used only by the
  discovery flow that finds new companies. The free tier covers it.

## Getting started

```
git clone <your-fork>
cd job-hunter-bot
npm install

cp config/profile.example.ts config/profile.ts
cp .env.example .env
```

Three things to set up:

1. **Resume.** Put your resume PDF at `config/resume.pdf`. On the first run it is
   extracted once to `config/resume.txt`, the plain text the relevance LLM judges
   against. If neither file exists the bot stops with an error, because there is
   nothing to match postings on. After you update the PDF, run `npm run extract-resume`
   to regenerate the text.
2. **Profile.** Open `config/profile.ts` and fill in your target roles, cities,
   deal-breakers, and denylists. Every field has a comment explaining what it is for.
   The shipped example is tuned for a data-analyst search in India; overwrite it.
3. **Discord.** Put your webhook URL into `.env` under `DISCORD_WEBHOOK_URL`. That is
   the only required env var; everything else has a sensible default.

`config/profile.ts`, `config/resume.pdf`, `config/resume.txt`, and `.env` are all
gitignored, so they stay on your machine.

## Commands

| | |
|---|---|
| `npm run once` | The main thing. One full sweep: fetch postings, filter, notify Discord, run discovery, upload a daily CSV report. |
| `npm run discover` | Discovery only. Pulls candidate companies from YC, RSS funding feeds, and Brave Search; does not touch postings. |
| `npm run extract-resume` | Re-extract `config/resume.pdf` into `config/resume.txt`. Run it after the PDF changes. |
| `npm run probe -- acme swiggy` | Looks up which ATS (if any) a company is on. Useful before adding entries to the registry. |
| `npm run verify` | Checks every entry in your registry is still reachable. Pass `--suggest` to re-probe failed entries against other ATSes. |
| `npm run scrape -- <slug>` | Walks one company through the llm-scrape pipeline so you can see what cheerio finds and what the LLM picks. |
| `npm run repair-urls` | Dry-runs URL repair on companies whose last fetch failed with a 404 or DNS error. Pass `--apply` to write the fixes. |
| `npm run eval` | Replays a labelled eval dataset through the gate and prints accuracy stats. |
| `npm run lint` | `eslint .` |
| `npm run typecheck` | `tsc --noEmit`. |

## How a posting moves through

The adapter layer does the fetching. Greenhouse, Lever, and Ashby return everything
(including JD bodies) in one request. Workday, SmartRecruiters, and the other API
providers return a listing first; the JD body comes from a second request, made only
for postings worth keeping. For companies that do not use a known ATS, the bot falls
back to a cheerio scrape of the careers page, and if cheerio sees too few links to
make sense of, a Playwright variant renders the page in headless Chromium and tries
again.

Each posting then runs a short gauntlet. Location filter first: if the posting's
location is not in your `targetCities`, country hints, or accepted-remote strings, it
is dropped without an LLM call. SQLite dedup next, keyed on `(provider, externalId)`.
Then a cheap regex on the title to skip postings obviously outside your target role
family (this is what `titleDenyPatterns` in your profile is for; it saves a slow LLM
call per drop).

Anything that survives gets a JD fetch (if the listing did not already include one),
then two LLM calls: a "gate" that returns a `matchScore` plus any deal-breaker hit,
and an "extract" that pulls minimum and maximum YOE from the JD text. The gate judges
the posting against your full resume text. The verdict is tri-state: green if the
score clears your threshold with no soft hits, yellow for borderline matches or soft
hits or unknown YOE, silent for hard deal-breakers and noise. Green and yellow both go
to Discord with different sidebar colors. Silent drops are still logged to the SQLite
DB so you can audit later.

Every run ends with a CSV bundle posted to Discord. `searched-<date>.csv` has one
row per matched posting (job title, link, score, green/yellow tier, reason) followed
by one row per company that errored or was skipped, with the reason to fix. A second
file, `discovery-<date>.csv`, shows up only if discovery turned anything up.

## The registry and adding a company

The company registry is a single git-tracked file, `config/companies.json`. It is the
one source of truth; the bot syncs it into the SQLite `companies` table on each run,
and discovery and repair write new or corrected entries back to it. An ATS entry looks
like:

```json
{
  "name": "Acme",
  "careers_url": "https://acme.example.com/careers",
  "source": "greenhouse",
  "source_slug": "acme",
  "parsing_strategy": "ats-api"
}
```

Before adding, run `npm run probe -- acme` to find out which ATS hosts their board. If
none of the supported ATSes match, set `source: "custom"` and
`parsing_strategy: "llm-scrape"`. If the careers page is a JavaScript-rendered SPA, use
`playwright-llm-scrape` instead.

Workday entries need one extra field, the tenant URL:

```json
"tenant_url": "https://acme.wd1.myworkdayjobs.com/External"
```

Workday has no directory of tenants, so finding these means hunting around the
company's careers page until you spot a `myworkdayjobs.com` link.

## Project layout

```
config/
  companies.json         the company registry (single source of truth)
  profile.ts             your deal-breakers + filters + locations    (gitignored)
  profile.example.ts     template; loader falls back to it
  resume.pdf             your resume PDF                             (gitignored)
  resume.txt             extracted resume text the gate judges on    (gitignored)
data/                    SQLite DB + caches                          (gitignored)
eval/                    offline gate-replay harness (replay.ts, dataset, metrics)
scripts/                 ops/maintenance CLIs: slug-probe, verify-registry,
                           scrape-probe, repair-urls-tool, url-repair
src/
  ats/                   one file per ATS provider; registry.ts maps provider names
                           to adapters; workday-facet.ts for faceted Workday search
  db/                    per-table modules (companies, postings, runs, quota, ...)
                           behind a barrel index.ts
  discovery/             YC + RSS + Brave sources; ats-patterns + ats-validate
  filter/                location / title / denylist / verdict
  llm/                   Ollama client; prompts/ holds gate.ts, extract.ts, shortlist.ts
  discord/               webhook + attachments uploader
  reports/               end-of-run CSV builder
  registry/              loads and validates config/companies.json into the companies table
  scraper/               cheerio + Playwright LLM fetchers for non-ATS careers pages
  util/                  shared helpers: semaphore, user-agent, slug, json
  tools/
    extract-resume.ts    PDF-to-text extraction (run via npm run extract-resume)
  pipeline/              run lifecycle (index.ts), scheduler.ts, posting-pipeline.ts
  config.ts              tunable knobs (workers, LLM model, discovery settings, ...)
  types.ts               shared TypeScript types
  profile.ts             loads config/profile.ts and attaches resume text
  logger.ts              pino logger setup
  index.ts               CLI entry point
```

## Writing a new ATS adapter

Look at `src/ats/types.ts` for the interface and `src/ats/greenhouse.ts` for the
simplest existing example. The contract:

- `listPostings(company)` is mandatory. Return one `NormalizedPosting` per role. Each
  needs a stable `externalId` (used for dedup) and ideally a `location` string.
- `fetchJd(company, posting)` is optional. Implement it if the listing endpoint does
  not include the JD body. The pipeline only calls it for postings that survived the
  location filter and dedup, so you only pay the HTTP cost for postings you would keep.

After writing the adapter:

1. Register it in `src/ats/registry.ts` under `ATS_ADAPTERS`.
2. Add the provider name to the `Provider` union in `src/types.ts`.
3. Add it to the zod enum in `src/registry/companies.ts`.

## A few things to know

The discovery flow is India-biased out of the box. The YC source filters to India, the
RSS feeds are Indian publications (Inc42, YourStory), and the Brave query pool is full
of India city names. If you are hunting somewhere else, edit `src/config.ts` under
`discovery`.

The bot creates `data/job_hunter.db` on the first run. SQLite WAL files live there too.
The `data/` directory is gitignored entirely.

The LLM gate and extract calls go through a semaphore (capped at one concurrent
generation by default) because Ollama serializes on the GPU anyway. HTTP work inside
one company fans out across `fetch.workersPerCompany` workers. If you run multiple
Ollama instances behind a load balancer, raise `llm.maxConcurrent` in `src/config.ts`.

If a careers page is bot-blocked (Cloudflare, Akamai, and the like), the bot does not
work around it; there is no headless-evasion code. The `manual` parsing strategy exists
for these. Entries marked manual stay in your registry but are never fetched, and they
surface as company rows in the daily `searched` CSV for hand-review.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
