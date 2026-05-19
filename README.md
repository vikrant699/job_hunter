# job-hunter-bot

A personal job-hunting bot. Pulls postings from a list of companies you care about,
filters them against your resume and deal-breakers, and pings the good matches to a
Discord channel.

It's manual — you run `npm run once` whenever you want a sweep. No cron, no daemon.
A single run takes 10–20 minutes for a registry of a few hundred companies, most of
which is waiting on the local LLM.

## What it needs

- Node 22 or newer (uses the built-in `node:sqlite`)
- [Ollama](https://ollama.com) running locally with a chat model pulled. The default is
  `qwen2.5:7b-instruct-q4_K_M`, which fits on most consumer GPUs:
  ```
  ollama pull qwen2.5:7b-instruct-q4_K_M
  ```
- A Discord webhook URL (Channel settings → Integrations → Webhooks → New Webhook)
- Optionally, a [Brave Search](https://brave.com/search/api/) API key — only for the
  discovery flow that finds new companies. Free tier covers it.

## Getting started

```
git clone <your-fork>
cd job-hunter-bot
npm install

cp config/profile.example.ts config/profile.ts
cp .env.example .env
```

Open `config/profile.ts` and fill it in. Every field has a comment explaining what
it's for. The shipped example sketches a data-analyst search in India — overwrite it
with your own resume blurb, target roles, target cities, deal-breakers.

Then put your webhook URL into `.env` under `DISCORD_WEBHOOK_URL`. That's the only
required env var; everything else has a sensible default.

Both `config/profile.ts` and `.env` are gitignored, so they stay on your machine.

## Commands

| | |
|---|---|
| `npm run once` | The main thing. One full sweep: fetch postings → filter → notify Discord → run discovery → upload a daily CSV report. |
| `npm run discover` | Discovery only. Pulls candidate companies from YC, RSS funding feeds, and Brave Search; doesn't touch postings. |
| `npm run probe -- acme swiggy` | Looks up which ATS (if any) a company is on. Useful before adding entries to the registry. |
| `npm run verify` | Checks every entry in your registry is still reachable. Pass `--suggest` to have it re-probe failed entries against other ATSes. |
| `npm run scrape -- <slug>` | Walks one company through the llm-scrape pipeline so you can see what cheerio finds and what the LLM picks. |
| `npm run repair-urls` | Dry-runs URL repair on companies whose last fetch failed with a 404/DNS error. Pass `--apply` to actually write the fixes. |
| `npm run typecheck` | `tsc --noEmit`. |

## How a posting moves through

The adapter layer does the fetching. Greenhouse, Lever and Ashby return everything
(including JD bodies) in one request. Workday and SmartRecruiters return a listing
first; the JD body comes from a second request, made only for postings we're going
to keep. For companies that don't use a known ATS, the bot falls back to a cheerio
scrape of the careers page — and if cheerio sees too few links to make sense of, a
Playwright variant renders the page in headless Chromium and tries again.

Each posting then runs a short gauntlet. Location filter first — if the posting's
location isn't in your `targetCities`, country hints, or accepted-remote strings,
it's dropped without an LLM call. SQLite dedup next, keyed on
`(provider, externalId)`. Then a cheap regex on the title to skip postings that are
obviously outside your target role family (this is what `titleDenyPatterns` in your
profile is for — it saves a 5-second LLM call per drop).

Anything that survives gets a JD fetch (if the listing didn't already include one),
then two LLM calls: a "gate" that returns a `matchScore` and whatever deal-breaker
hit, and an "extract" that pulls minimum and maximum YOE from the JD text. The
verdict is tri-state: green if the score clears your threshold with no soft hits,
yellow for borderline matches or soft hits or unknown YOE, silent for hard
deal-breakers and noise. Green and yellow both go to Discord, with different
sidebar colors. Silent drops are still logged to the SQLite DB so you can audit
later.

Every run ends with a CSV bundle posted to Discord: `searched-<date>.csv` (every
company we touched and what it produced), `unchecked-<date>.csv` (every company
we skipped and why), and `discovery-<date>.csv` if discovery turned anything up.

## Adding a company

Edit `config/companies.seed.json`. An ATS entry looks like:

```json
{
  "name": "Acme",
  "careers_url": "https://acme.example.com/careers",
  "source": "greenhouse",
  "source_slug": "acme",
  "parsing_strategy": "ats-api"
}
```

Before adding, run `npm run probe -- acme` to find out which ATS hosts their board.
If none of the supported ATSes match, set `source: "custom"` and
`parsing_strategy: "llm-scrape"`. If the careers page is a JavaScript-rendered SPA
(Swiggy, Zerodha, Cred — the usual suspects), use `playwright-llm-scrape` instead.

Workday entries need one extra field — the tenant URL:

```json
"tenant_url": "https://acme.wd1.myworkdayjobs.com/External"
```

Workday doesn't have a directory of tenants, so finding these means hunting around
the company's careers page until you spot a `myworkdayjobs.com` link.

## Project layout

```
config/
  profile.ts             your resume + deal-breakers + locations    (gitignored)
  profile.example.ts     template; loader falls back to it
  companies.seed.json    the company registry
data/                    SQLite DB + working overlay + link cache   (gitignored)
src/
  ats/                   one file per ATS provider, plus a small html-to-text helper
  scraper/               cheerio + Playwright fetchers for non-ATS careers pages
  discovery/             YC + RSS + Brave sources; the URL-repair tool
  filter/                location / title / denylist / verdict
  llm/                   Ollama client + gate, extract, shortlist prompts
  discord/               webhook + CSV uploader
  reports/               end-of-run CSV builder
  registry/              loads and validates the JSON registry into the companies table
  db/                    SQLite setup + queries
  pipeline.ts            company → postings → Discord
  profile.ts             loader that picks profile.ts over profile.example.ts
  index.ts               CLI entry point
```

## Writing a new ATS adapter

Look at `src/ats/types.ts` for the interface and `src/ats/greenhouse.ts` for the
simplest existing example. The contract:

- `listPostings(company)` is mandatory. Return one `NormalizedPosting` per role.
  Each needs a stable `externalId` (used for dedup) and ideally a `location`
  string.
- `fetchJd(company, posting)` is optional. Implement it if the listing endpoint
  doesn't include the JD body — the pipeline only calls it for postings that
  survived the location filter and dedup, so you only pay the HTTP cost for
  postings you'd actually keep.

After writing the adapter:

1. Register it in `src/pipeline.ts` under `ATS_ADAPTERS`.
2. Add the provider name to the `Provider` union in `src/types.ts`.
3. Add it to the zod enum in `src/registry/companies.ts`.

## A few things to know

The discovery flow is India-biased out of the box. The YC source filters to India,
the RSS feeds are Indian publications (Inc42, YourStory), and the Brave query pool
is full of India city names. If you're hunting somewhere else, edit
`src/config.ts` → `discovery` to taste.

The bot creates `data/job_hunter.db` on first run. SQLite WAL files live there
too. The `data/` directory is gitignored entirely.

The LLM gate and extract calls go through a semaphore (capped at 1 concurrent
generation by default) because Ollama serializes on the GPU anyway. HTTP work
inside one company fans out across `fetch.workersPerCompany` workers. If you run
multiple Ollama instances behind a load balancer, bump `llm.maxConcurrent` in
`src/config.ts`.

If a careers page is bot-blocked (Cloudflare 403s, Akamai, etc.), the bot won't
work around it — there's no headless-evasion code. The `manual` parsing strategy
exists for these; entries marked manual stay in your registry but never get
fetched, and surface in the daily "unchecked" CSV for hand-review.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
