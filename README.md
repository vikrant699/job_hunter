# job-hunter-bot

A personal job-hunting bot. It pulls postings from a list of companies you care about,
filters them against your resume and deal-breakers, scores each with a local LLM, records
the good matches to a Google Sheet, and drafts outreach emails to the matching companies'
recruiters (drafts only - you review and send). Discord is used only for run status.

You run it by hand with `npm run once` whenever you want a sweep. A full sweep over the
~1,300-company registry takes several hours - most of it waiting on the local LLM and on
slow JavaScript-rendered careers pages. Incremental runs (most postings already seen and
deduped from earlier runs) finish much faster.

## What it looks like

Matches land in a Google Sheet, color-coded by confidence: green for a strong match,
yellow for borderline (e.g. slightly over the years-of-experience cap). Each row shows
the role, location, YOE, a one-line "why it matched", and the relevance score; matching
companies' recruiters also get a drafted outreach email (drafts only - you review and
send). Discord carries only run status: while a run is in flight an optional progress
heartbeat posts every 15 minutes (how far along it is, jobs seen and relevant so far, and
a per-strategy breakdown), and at the end of every run a single summary embed posts
(companies scanned, postings seen, green/yellow counts, duration, and any errors).

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
- Optionally, a Discord webhook (`DISCORD_PROGRESS_WEBHOOK_URL`) for run status: a
  mid-run progress heartbeat every 15 minutes plus the single end-of-run summary embed.
  It is the only Discord surface. Leave unset to skip (status is logged instead).

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
3. **Discord (optional).** For run-status pings, put a webhook URL into `.env` under
   `DISCORD_PROGRESS_WEBHOOK_URL`. Leave it unset and run status is just logged instead.

`config/profile.ts`, `config/resume.pdf`, `config/resume.txt`, and `.env` are all
gitignored, so they stay on your machine.

**Multiple profiles.** To run more than one search (e.g. two people, or two role
families), put each under `config/profiles/<name>/profile.ts` with its own `resume.pdf`,
and run `npm run once -- --profile <name>`. Setting the `PROFILE` env var instead of
passing `--profile <name>` selects the same way. Each profile can set its own
relevance-gate prompt (`gatePrompt`) and outreach identity; postings and runs are
stamped per profile in the DB. Without `--profile` or `PROFILE`, the bot uses
`config/profile.ts` (the "default" profile). The whole `config/profiles/` tree is
gitignored.

## Commands

| | |
|---|---|
| `npm run once` | The main thing. One full sweep: fetch postings, filter, score, record matches to the Google Sheet, draft outreach emails, and post an end-of-run status embed to Discord. Add `-- --profile <name>` for a named profile. |
| `npm test` | Runs the test suite (`node:test`). |
| `npm run extract-resume` | Re-extract `config/resume.pdf` into `config/resume.txt`. Run it after the PDF changes. |
| `npm run google-auth -- --profile <name>` | One-time Google OAuth consent for a profile's Gmail account; writes `data/google-token-<name>.json`. |
| `npm run bootstrap-sheet` | Idempotent outreach-spreadsheet setup: creates the bot's tabs and seeds Raw Data/Companies from local files when present. |
| `npm run verify-outreach -- --profile <name>` | Standalone bounce-only verify pass over one profile's mailbox, then re-projects the sheet (this also runs automatically inside `npm run once`). |
| `npm run probe -- acme swiggy` | Looks up which ATS (if any) a company is on. Useful before adding entries to the registry. |
| `npm run verify` | Checks every entry in your registry is still reachable (verifies against the local registry cache snapshot, so run it after at least one successful sync). Pass `--suggest` to re-probe failed entries against other ATSes. |
| `npm run scrape -- <slug>` | Walks one company through the llm-scrape pipeline so you can see what cheerio finds and what the LLM picks. |
| `npm run health` | Read-only registry health report: status/strategy/provider yield tallies from the local DB and cache. |
| `npm run db:push -- --profile <name>` | Upload the SQLite DB to Google Drive so another machine can pick it up. |
| `npm run db:pull -- --profile <name>` | Download it back, integrity-checked before replacing the local file. |
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

SuccessFactors boards (both the CSB JSON API and the legacy HTML board) additionally
cross-check the tenant's `/sitemap.xml`, which lists every posting in one request;
ids the paginated listing missed are gap-filled from it, so unstable pagination can
no longer drop jobs.

Anything that survives gets a JD fetch (if the listing did not already include one),
then two LLM calls: a "gate" that returns a `matchScore` plus any deal-breaker hit,
and an "extract" that pulls minimum and maximum YOE from the JD text. The gate judges
the posting against your full resume text. The verdict is tri-state: green if the
score clears your threshold with no soft hits, yellow for borderline matches or soft
hits or unknown YOE, silent for hard deal-breakers and noise. Green and yellow are both
recorded to the Google Sheet, color-coded by tier. Silent drops are still logged to the SQLite
DB so you can audit later. A profile can also set `neverSilenceTitlePatterns` - titles
that are floored to yellow instead of silenced even at a low score (for a rare
sub-specialty worth eyeballing), unless they hit a hard deal-breaker or the YOE cap.

Postings also carry a lifecycle. Every successful company fetch bumps `last_seen_at`
for each posting the board still lists; a posting missing from the snapshot gets
`removed_at` stamped (and cleared again if it reappears). Outreach never drafts
against a posting the board has taken down, and each company fetch writes an
added/removed/unchanged diff row (kept for the last 60 fetches per board) that
`npm run health` reads to surface churn and removal trends.

Every run ends with a single Discord message: a "run complete" embed (companies
scanned, postings seen, new postings, green/yellow counts, duration, and any errors).
The matched postings themselves live in the Google Sheet (one row per match with job
title, link, score, green/yellow tier, and reason), and matching companies also get
drafted outreach emails on the sheet's Drafts/Undrafted tabs. Companies that errored,
are stuck on `manual`, or look like a silently-failing scrape (a fragile scraper that
returned zero) are recorded in the DB and run logs with the reason to fix.

While a run is in flight, a progress heartbeat is posted every 15 minutes to the
`DISCORD_PROGRESS_WEBHOOK_URL` channel (companies scanned out of total, jobs
seen, jobs relevant, and a per-strategy breakdown) so you can watch a long run without
tailing logs.

## The registry and adding a company

The company registry is the Companies tab of your outreach Google Sheet. It is the one
source of truth; the bot syncs it into the SQLite `companies` table on each run, and
writes one kind of update back to it (the SPA sentinel's llm-scrape to
playwright-llm-scrape strategy flip). `data/registry-cache.json` is a bot-maintained
local snapshot of the tab, used only as an offline fallback when the sheet is
unreachable - it is not itself a source of truth, and it is not git-tracked. An ATS
entry's columns look like (see `src/registry/sheetCodec.ts` for the exact column order):

| name | careers_url | source | source_slug | parsing_strategy |
|---|---|---|---|---|
| Acme | https://acme.example.com/careers | greenhouse | acme | ats-api |

Before adding, run `npm run probe -- acme` to find out which ATS hosts their board, and
check the tab first - the company may already be present under a non-obvious slug. If
none of the supported ATSes match, set `source` to `custom` and `parsing_strategy` to
`llm-scrape`. If the careers page is a JavaScript-rendered SPA, use
`playwright-llm-scrape` instead.

Workday entries need one extra column, the tenant URL:

```
tenant_url: https://acme.wd1.myworkdayjobs.com/External
```

Workday has no directory of tenants, so finding these means hunting around the
company's careers page until you spot a `myworkdayjobs.com` link. The career-site
name (the path segment, e.g. `/External`) is listed in the tenant's
`robots.txt` (`Allow: /<site>/` lines) if you need to confirm it. If a configured
site name goes stale, the bot reads robots.txt itself: when exactly one site
exists there it retries against it and logs a "workday site drift" warning;
otherwise it logs the candidates for you to repoint the row.

Each entry also carries a `status`. `active`/`candidate` are scanned normally.
`denied` is excluded from every scan - used for genuine dead ends (defunct or acquired
companies, duplicate rows already covered by another entry, and IT-services/staffing
body-shops that are out of scope). `dormant` is a softer quarantine for a real company
that currently has no reachable public board (careers page is email/aggregator-only,
WAF-walled, or temporarily broken) - kept on the books to revisit if a channel opens,
but skipped by scans for now.

## Project layout

```
config/
  profile.ts             your deal-breakers + filters + locations    (gitignored)
  profile.example.ts     template; loader falls back to it
  profiles/<name>/       named profiles (profile.ts + resume.pdf)     (gitignored)
  resume.pdf             your resume PDF                             (gitignored)
  resume.txt             extracted resume text the gate judges on    (gitignored)
data/                    SQLite DB, registry-cache.json, other caches (gitignored)
scripts/                 ops/maintenance CLIs: slug-probe, verify-registry,
                           scrape-probe
src/
  ats/                   one file per ATS provider; registry.ts maps provider names
                           to adapters; detect.ts holds the ATS-redirect detection
                           patterns llm-scrape uses; workdayFacet.ts for faceted
                           Workday search
  db/                    per-table modules (companies, postings, runs, recruiters,
                           outreach, link-cache, api-meta) behind a barrel index.ts
  filter/                location / title / denylist / verdict
  google/                auth.ts (per-profile OAuth token refresh), rest.ts
                           (authorized fetch + retry), sheets.ts, gmail.ts, mime.ts
                           (RFC 5322 draft builder)
  llm/                   Ollama client; prompts/ holds gate.ts, extract.ts, shortlist.ts
  discord/               webhook helper + progress heartbeat + end-of-run status embed
  outreach/              contact sync from the sheet (contacts.ts), the company/contact
                           matcher (match.ts), the email template (template.ts), the
                           post-run Gmail draft stage (run.ts), the bounce-only verify
                           pass (verify.ts), and the DB -> sheet projection (sheetSync.ts)
  registry/              sheetRegistry.ts syncs the Companies tab (with a
                           registry-cache.json fallback) into the companies table;
                           sheetCodec.ts converts between tab rows and RegistryEntry;
                           sheetWriter.ts is the write path back to the tab (the SPA
                           sentinel's strategy flip, and appendToRegistry for
                           registry-maintenance sessions)
  scraper/               cheerio + Playwright LLM fetchers for non-ATS careers pages
  blast/                 TEMPORARY weekly cold-email drafter over the Raw Data tab;
                           see AGENTS.md for details and its deletion checklist
  util/                  shared helpers: semaphore, sleep, user-agent, slug, json,
                           csv, probe, fs, regex, env, registry-file
  tools/
    extractResume.ts    PDF-to-text extraction (run via npm run extract-resume)
  pipeline/              run lifecycle (index.ts), scheduler.ts, postingPipeline.ts
  config.ts              tunable knobs (workers, LLM model, fetch timeouts, ...)
  types.ts               shared TypeScript types
  schemas.ts             zod schemas (providers, registry entry, user profile)
  profile.ts             loads the selected profile and attaches resume text
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

After writing the adapter, wire it into two places (plus one optional step):

1. Add the provider name to the `ProviderSchema` zod enum in `src/schemas.ts` - the
   `Provider` type is inferred from it, so that one edit covers both the type and the
   runtime validation the registry loader runs.
2. Register the adapter in `src/ats/registry.ts` under `ATS_ADAPTERS`. This map is
   checked against the enum at compile time (`satisfies Record<Exclude<Provider,
   "custom">, AtsAdapter>`), so a forgotten registration is a `tsc` error instead of a
   company that silently never gets scanned; `src/ats/__tests__/registry.test.ts` also pins the
   enum/map completeness.
3. Optional: if the vendor has a shared host signature (e.g. tenants live under
   `*.vendor.com`), add a `PatternDef` to `src/ats/detect.ts` so the ATS-redirect
   detector that llm-scrape uses can recognize boards that link out to it. Skip this
   for single-company or custom-domain vendors.

Most adapters hit a public JSON or server-rendered HTML endpoint and need nothing more.
Some sit behind a WAF or an anti-bot host and are browser-backed via
`src/ats/browserFetch.ts` (headless Chromium through the shared Playwright pool);
a few decrypt an obfuscated payload or lift a token from the page bundle. Reuse the
shared helpers (`atsFetchJson`/`atsFetchText` in `http.ts`, `paginate`/`REMOTE_RE` in
`shared.ts`, `htmlToText`) rather than re-rolling them.

There are just over 100 providers today, spanning the big ATSes (greenhouse, lever, ashby,
workday, smartrecruiters, oracle, successfactors, darwinbox, phenom, avature, jibe,
eightfold, ...), India-centric vendors (keka, peoplestrong, ripplehire, turbohire,
zwayam, sensehq, mynexthire, freshteam, zohorecruit, ...), SMB boards (teamtailor,
comeet, pyjamahr, goodfit, recruiterflow, bamboohr, trakstar, kula, ...), and bespoke
single-company adapters (amazonjobs, metacareers, apple, mercedes, moglix, icicibank,
reliance, tatacareers, adityabirla, ...) - plus `custom` for llm-scrape /
playwright-llm-scrape. See `ProviderSchema` in `src/schemas.ts` for the full list.

The bot creates `data/job_hunter.db` on the first run. SQLite WAL files live there too.
The `data/` directory is gitignored entirely.

The LLM gate and extract calls go through a semaphore (capped at one concurrent
generation by default) because Ollama serializes on the GPU anyway. HTTP work inside
one company fans out across `fetch.workersPerCompany` workers. If you run multiple
Ollama instances behind a load balancer, raise `llm.maxConcurrent` in `src/config.ts`.

If a careers page is bot-blocked (Cloudflare, Akamai, and the like), the bot does not
work around it; there is no headless-evasion code. The `manual` parsing strategy exists
for these. Entries marked manual stay in your registry but are never fetched, and they
show up in the registry health report (`npm run health`) for hand-review.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
