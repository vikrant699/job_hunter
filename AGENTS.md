# AGENTS.md

Guidance for AI agents running and contributing to this repo. It is the single source of
truth for agents (`CLAUDE.md` only points here). Human setup lives in `README.md`; keep the
two consistent when behavior changes.

## What this is

A personal job-hunting bot, run by hand (`npm run once`), never on a schedule. Single
user, not a public service. One run:

1. Pre-flight (`src/index.ts`): starts the network heartbeat, checks OpenRouter (key, model
   slug, pinned providers) and the profile's Google token.
2. Pulls a newer SQLite DB from Google Drive if one exists, THEN dynamically imports
   `src/runOnce.ts` (see Environment > DB sync for why the order matters).
3. Syncs the Companies tab of the outreach spreadsheet into the `companies` table.
4. Tick (`src/pipeline/`): fetch every scannable board, filter (location, dedup, title,
   YOE, junk JD), score with the LLM gate, record a green/yellow/silent verdict.
5. Outreach: bounce-only verify pass over the mailbox (draft->sent/discarded,
   sent->bounced/verified), then Gmail drafts per matching company/recruiter (drafts only,
   a human sends), then the DB->sheet projection (Drafts/Sent/Undrafted tabs).
6. One Discord status embed (Discord carries only run status: mid-run heartbeats + this).
7. Closes the DB and pushes it to Drive.

## Commands

| Command | What it does |
|---|---|
| `npm run once` | One full run (above). `-- --profile <name>` (or `PROFILE=<name>`) for a named profile. |
| `npm test` | `node:test` suite. `test-setup.mjs` points `JOB_HUNTER_DB_PATH` at a throwaway DB first, so tests never touch `data/job_hunter.db` (whose rows get projected onto the real sheet). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint . --max-warnings 0` (a warning also fails). |
| `npm run extract-resume` | Re-extract `resume.pdf` to `resume.txt` (`-- --profile <name>` for a named profile's dir). Startup also re-extracts whenever the PDF is newer. |
| `npm run google-auth -- --profile <name>` | Google OAuth consent; writes `data/google-token-<name>.json` (no flag = `default`). |
| `npm run bootstrap-sheet` | Idempotent spreadsheet setup: ensures Raw Data/Drafts/Sent/Undrafted/Companies tabs, seeds Raw Data from `config/recruiters-raw.csv` and Companies from `data/registry-cache.json` when those exist and the tab is empty, writes headers, adds E1:G1 to Recruiters List. Recruiters List itself must already exist. |
| `npm run verify-outreach -- --profile <name>` | Standalone verify pass + sheet projection (also runs inside `once`). |
| `npm run blast -- --profile <name>` | TEMPORARY weekly cold-email drafter over Raw Data (drafts only; state at `data/blast-state-<name>.json`; projects a Blast Log tab). `--profile` is required. Flags: `--limit N` (default 100), `--verify-only`, `--force`. When the campaign ends delete `src/blast/`, `scripts/blast.ts`, the npm script and this row. |
| `npm run health` | Read-only registry report from the local DB + cache (status/strategy/provider tallies, failure streaks, yield). |
| `npm run resync-registry -- --profile <name>` | Companies tab -> DB sync without a run. Run it after any registry write; prints `{synced, denied, pruned, invalidRows}`. Prune only runs when every row validates, so check `invalidRows` if `pruned` is unexpectedly 0. |
| `npm run db:push -- --profile <name>` | Upload `data/job_hunter.db` to Drive (WAL-checkpointed first). Refuses if Drive is newer, the local DB has no postings, or it is under half the remote's size; `--force` overrides. |
| `npm run db:pull -- --profile <name>` | Download it back, integrity-checked in a temp file before the swap. Refuses if local is newer; `--force` overrides. |
| `npm run probe-url -- <url> [--profile <name>] [--gate]` | "Why isn't this posting in my list?": resolves a job URL to (provider, board, id), prints the company row, the posting's lifecycle/gate fields, and recent board_runs; checks the live listing if the posting is unknown. `--gate` also runs the real gate (one LLM call). Read-only. |
| `npm run probe -- <name> [...]` | Slug guesser for **greenhouse, lever and ashby only** (`scripts/slugProbe.ts`). A MISS says nothing about the other providers. |
| `npm run verify [-- --suggest] [--only-broken]` | Probes every entry in `data/registry-cache.json` (so it needs one prior sync). `--suggest` re-probes failures against greenhouse/lever/ashby; `--only-broken` prints only failures. |
| `npm run scrape -- <slug> [...] [--jd] [--no-llm] [--html-head] [--dump-anchors]` | Walks one company through the llm-scrape path. |
| `npx tsx scripts/diagSweep.ts <outDir> [provider]` | Read-only diagnostic sweep over active boards, NDJSON output, resumable. No npm script. |

Never run `once`, `blast`, `db:push`/`db:pull`, or `google-auth` as a "check"
without the owner asking: they touch real mailboxes and the Drive backup.

## Before you commit (non-negotiable)

```
npm test            # all green
npx tsc --noEmit    # no errors
npm run lint        # ZERO warnings or errors
```

Commits go straight to `master` (no branch/PR flow in this repo) once all three are clean.
Commit messages use conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`,
`docs:`, `chore:`).

## Type-hygiene rules

Rules marked (lint) are enforced by `eslint.config.js`; the rest are review conventions
that the `no-unsafe-*` rules push you toward.

1. (lint) **No type assertions** except `as const`. No `x as T`, `x as unknown as T`, `<T>x`.
   If a value needs to be `T`, fix the upstream type or validate it (rule 4).
2. (lint) **No `any`**, including tests, and no unsafe flows of it (`no-unsafe-assignment`,
   `-member-access`, `-call`, `-return`, `-argument`).
3. (lint) **No hand-written `unknown`** (`no-restricted-types`). Where a library hands you an
   untyped value (`JSON.parse`, `res.json()`, a `node:sqlite` row, `page.evaluate`),
   validate it *at that point* with `JsonValueSchema.parse(...)` and carry it as
   `JsonValue` (rule 6). The ATS fetch helpers (`atsFetchJson`, `atsFetchFormJson`,
   `atsFetchJsonMultipart` in `src/ats/http.ts`; `browserFetchJson*` in
   `src/ats/browserFetch.ts`) and `google/rest.ts` already do this, so every adapter parse
   function takes `JsonValue`. A value that came out of `catch` or a rejection is typed
   `Caught` (from `src/util/errorCause.ts`), never `unknown`; `Caught` is only for caught
   values.
4. **Validate at boundaries, type the interior.** Every place external data enters (DB rows,
   parsed JSON, HTTP JSON, LLM output) gets a zod schema; the typed value comes from
   `schema.parse(...)` and `type X = z.infer<typeof XSchema>`.
5. **Literal data uses `as const`** (lookup tables, enum-ish arrays, the adapter map) rather
   than a wide annotation.
6. **Arbitrary JSON walking** (Workday facet tree, Phenom `ddo` island) uses `JsonValue` /
   `JsonValueSchema` from `src/util/json.ts`, narrowed with `typeof` / `Array.isArray` /
   `in`. Never `Record<string, unknown>` or a cast.
7. **Schemas vs types are separated.** Runtime zod schemas live in `src/schemas.ts`;
   `src/types.ts` holds only erasable types and imports inferred enum types from
   `schemas.ts`. No schemas in `types.ts`.
8. (lint) **Type imports are their own statement.** `import type { X } from "./x.js";`, never
   an inline `{ value, type X }` mix (`consistent-type-imports` + a `no-restricted-syntax`
   selector for the mixed shape).
9. (lint) **No TypeScript `enum`.** Use a const object with `as const` and derive the type.
10. (lint) **No non-null assertions** (`x!`) and **no unnecessary conditions**
    (`no-unnecessary-condition`: a check the types prove is always true/false fails lint;
    fix the type instead). A value that must stay a real runtime check is typed wide on
    purpose (see `INTER_CALL_DELAY_MS: number` in `src/config.ts`).
11. (lint) **Promises are handled** in production code: `no-floating-promises`,
    `no-misused-promises`, `await-thenable` (test files are exempt from this block).
12. (lint) **Filenames are camelCase** (`unicorn/filename-case`); `__tests__` / `__mocks__`
    are exempt.
13. (lint) **Tests live in `__tests__/`** next to the code they cover
    (`local/tests-in-tests-folder` from `eslint-local-plugin.js`).
14. (lint) **No `eslint-disable` comments of any kind.** `linterOptions.noInlineConfig` makes
    them inert and each one warns, which `--max-warnings 0` fails. If a rule is wrong for a
    real case, change it in `eslint.config.js` with the reason.

Test-side idioms: get a thrown value with `thrownBy` / `rejectionOf` from
`src/__tests__/caught.ts`; leave `assert.rejects` validator parameters un-annotated (they
are contextually typed); capture logs with `captureLogs` from `src/__tests__/logCapture.ts`
(built on `setLogSink` in `src/logger.ts`) instead of reassigning logger methods; prefer a
generic (`function jsonResponse<T>(body: T)`) over `unknown`; hand a schema-typed fixture to
a `JsonValue` parser with `asJson(fixture)` from `src/ats/__tests__/testHelpers.ts`.

## Where things live

```
src/
  index.ts       entrypoint: pre-flight, DB pull ONLY. Must not statically import
                   anything that reaches db/db.ts (see Environment > DB sync)
  runOnce.ts     the run body (registry sync -> tick -> verify -> outreach -> projection ->
                   status), dynamically imported by index.ts once the DB is current
  config.ts      runtime knobs (fetch, llm, network, storage, discord, google tabs,
                   outreach cooldown); personal settings live in the profile, not here
  profile.ts     loads the selected profile (named dir, config/profile.ts, else the example),
                   validates it, attaches resume text
  schemas.ts     zod schemas + inferred types (ProviderSchema, CompanyStatusSchema, ...)
  types.ts       erasable types only
  logger.ts      pino (UTC timestamps); setLogSink is the test seam
  ats/           one file per provider; registry.ts (ATS_ADAPTERS provider->adapter map,
                   resolveAdapter); types.ts (AtsAdapter); http.ts (fetchOk + atsFetchJson/
                   FormJson/JsonMultipart/Text); shared.ts (paginate, REMOTE_RE, unixToIso,
                   parsePostedOn); browserFetch.ts (shared Playwright pool for WAF/anti-bot
                   hosts); jsonList.ts (factory for one-shot unpaginated JSON boards);
                   htmlText.ts; workdayFacet.ts; sfSitemap.ts (SuccessFactors /sitemap.xml
                   gap-fill shared by sfcsb.ts + successfactors.ts); detect.ts (ATS-redirect
                   PatternDefs used by llm-scrape); jsonld.ts (generic sitemap + schema.org
                   JobPosting adapter for sites with no real ATS)
  scraper/       the llm-scrape path for provider `custom`: cheerio.ts, playwright.ts,
                   llmScrape.ts, playwrightLlmScrape.ts, jsonLd.ts, pageSignals.ts
                   (is-this-a-careers-page heuristics)
  filter/        location, title, denylist (+ noiseDenylist.ts: hand-researched never-re-add
                   slugs), dedup (company|title|location notify key), yoe (regex YOE before the LLM
                   extract), junkJd (placeholder JDs -> no-jd drop), salary (mechanical
                   stated-pay extraction), verdict (green/yellow/silent)
  pipeline/      index.ts (tick lifecycle, bucketing, dormancy), scheduler.ts (concurrency,
                   provider throttle, transport retry, deferred pass), postingPipeline.ts
                   (per-posting gauntlet, lateLocationCheck after fetchJd)
  llm/           client.ts (semaphore, retry, circuit-breaker facade); openrouter.ts (the
                   transport; OpenRouter is the ONLY backend); errors.ts (LlmUnavailableError);
                   gate.ts, extract.ts, shortlist.ts, extractTextJobs.ts, render.ts;
                   prompts/ holds the prompt strings
  db/            db.ts (singleton, opens the file AT IMPORT; queryAll/queryOne); schema.sql;
                   per-table modules behind the index.ts barrel (companies, postings, runs,
                   boardRuns, recruiters, outreach, linkCache, apiMeta); sync.ts (Drive
                   push/pull + staleness guard); openState.ts (the one bit sync.ts needs from
                   db.ts without importing it)
  registry/      sheetRegistry.ts (Companies tab -> DB, cache fallback); companies.ts
                   (shared upsert+prune core, cache reader); sheetCodec.ts (row <->
                   RegistryEntry, REGISTRY_COLUMNS order); sheetWriter.ts (the only write
                   path to the tab: SPA-sentinel strategy flip + appendToRegistry)
  outreach/      contacts.ts (Raw Data + Recruiters List -> recruiters table), match.ts
                   (company normalizer, contact tiers, cooldown), template.ts, run.ts (Gmail
                   drafts), verify.ts (bounce-only verify + raw-csv promotion to Recruiters
                   List), roles.ts, sheetSync.ts (DB -> tab projection), tabs.ts (header
                   contracts)
  google/        auth.ts (per-profile token refresh + expiry guard), rest.ts (authorized
                   fetch + retry), sheets.ts, gmail.ts, mime.ts (RFC 5322 builder), drive.ts
                   (resumable binary upload/download of the DB)
  discord/       webhook.ts, progress.ts (15-min heartbeat), status.ts (end-of-run embed)
  blast/         TEMPORARY cold-email campaign (see Commands); nothing else imports it
  tools/         extractResume.ts (PDF -> resume.txt; npm run extract-resume)
  util/          semaphore, sleep, userAgent, slug (resolveSlug, registryKey), json
                   (JsonValue), csv, probe, fs (writeFileAtomic), registryFile (writeAtomic
                   for the cache), regex (matchGroup), env (envInt, envList), httpRetry
                   (Retry-After), errorCause (transport vs edge vs board classification +
                   Caught), connectivity (outage heartbeat), jobUrlResolver (probe-url),
                   aggregatorGuard (warns when one board spans >10 hiring-org names)
  __tests__/     repo-wide test helpers (caught.ts, logCapture.ts) + indexImportGraph.test.ts
config/          profile.example.ts, outreach-template.md (tracked); profile.ts, resume.*,
                   recruiters-raw.csv, profiles/<name>/ (gitignored)
scripts/         ops/maintenance CLIs (not part of the run); atsProbes.ts is a library for
                   slugProbe/verifyRegistry
data/            SQLite DB, registry-cache.json, google-token-*.json, blast state (gitignored)
docs/, temp/     owner's local plans and scratch scripts (gitignored; absent in a fresh clone)
```

Tests: `src/ats/foo.ts` is covered by `src/ats/__tests__/foo.test.ts`; shared ATS fixture
helpers are in `src/ats/__tests__/testHelpers.ts` (`stubFetch`, `fetchSequence`,
`jsonResponse`, `mkAdapterCompany`, `asJson`). The `npm test` glob (`src/**/*.test.ts`)
matches at any depth, so a new `__tests__/` needs no config change.

## Conventions

### Code

- **TDD for new logic:** write the failing `node:test` test first, watch it fail, then
  implement. Refactors must be behavior-preserving (the suite is the safety net).
- **Don't reintroduce duplication.** Shared helpers live in `src/util/` and
  `src/ats/shared.ts`; use them.
- **Comments are at most one line**, state a constraint the code cannot, and are omitted
  when the code can say it. No block narration, file-tour headers, section dividers, or
  history. Adapter files may open with at most 2 single-line comments (list + detail
  endpoint recipes).
- **Docs use no em dashes** (hyphens or rephrase). Applies to `README.md` and this file.
- **No personal data in git.** Real resumes, profiles, recruiter dumps and tokens stay in
  gitignored paths; fixtures and examples use dummies.
- **Never bulk-delete `data/`** (e.g. `rm data/*.json`): the per-profile OAuth tokens live
  there and re-consent is manual.

### New ATS adapter

The `AtsAdapter` contract (`src/ats/types.ts`) is `provider`, `listPostings(company)`
(required; one `NormalizedPosting` per role with a stable `externalId`), and optional
`fetchJd(company, posting)` (called only for postings that survived location + dedup; it
may refine `posting.location`/`jobUrl` in place, and the pipeline re-checks location after
it). `src/ats/greenhouse.ts` is the simplest example. Wiring:

1. Add the provider to `ProviderSchema` in `src/schemas.ts`.
2. Register it in `ATS_ADAPTERS` in `src/ats/registry.ts`. The map `satisfies
   Record<Exclude<Provider, "custom">, AtsAdapter>`, so forgetting either side is a tsc
   error, and `src/ats/__tests__/registry.test.ts` pins it.
3. OPTIONAL: for a shared host signature (e.g. `*.vendor.com` tenants), add a `PatternDef`
   to `src/ats/detect.ts` so llm-scrape can recognize boards that link out to it. Not for
   single-company or custom-domain vendors.

Write fixture tests first with `testHelpers.ts`. Reuse `atsFetchJson`/`atsFetchText`,
`paginate`, `REMOTE_RE`, `unixToIso`, `jsonList.ts` for one-shot boards, and
`browserFetch.ts` for WAF/anti-bot hosts. There are 127 providers (`ProviderSchema` minus
`custom`); some are browser-backed, a few crack an encrypted payload or lift a token from
the page bundle (`icicibank`, `moglix`, `magicpin`, `metacareers`), and `icims`/`sirion`
launch Playwright with `channel: "msedge"` because bundled Chromium is WAF-blocked.

- **NEVER truncate a board.** Adapters page to the end; the `paginate` backstop in
  `src/ats/shared.ts` (5000 pages) is a runaway guard, not a limit. If a board looks
  capped, find the real pagination mechanism.
- **JS-gated is not a reason to scrape.** Capture the SPA's public XHR endpoint and build an
  adapter; only login-walled boards (or none at all) may stay on llm-scrape/`manual`.
- **WAF-blocked:** try the Edge channel before quarantining.
- **After building a shared-vendor adapter**, enumerate its other tenants for more companies.

### Registry (the Companies tab)

- **The Companies tab of the outreach spreadsheet is the single source of truth.** It is
  synced into the SQLite `companies` table every run; the DB is a derived cache and a
  DB-only change reverts on the next sync (nothing writes back except the SPA-sentinel
  strategy flip). `data/registry-cache.json` is a bot-written snapshot used only when the
  sheet is unreachable, written only after a fully valid sync.
- **Appends from maintenance sessions** go through `appendToRegistry` in
  `src/registry/sheetWriter.ts` (dedupes on `registryKey` = source + resolved slug, mirrors
  the cache); never raw Sheets calls. Then `npm run resync-registry`.
- **Check before adding:** many companies already exist under non-obvious slugs; query the
  DB/tab by name first.
- **A company on two ATSes:** compare the India job sets by title; keep both rows if they
  are disjoint, drop one only if they list the same jobs.
- **Columns** are `REGISTRY_COLUMNS` in `src/registry/sheetCodec.ts`. `parsing_strategy` is
  `ats-api` | `llm-scrape` | `playwright-llm-scrape` | `manual`; only the first three are
  fetched. `category` and `employer_type` are curation labels, not read by the pipeline.
- **Company `status`** (`CompanyStatusSchema`): `active` (or blank in the sheet) is scanned
  every run. `denied` is permanently excluded (dead/acquired, duplicate of another row,
  services/staffing). `dormant` is an alive company with no reachable board: scanned only
  when `last_fetched_at` is 7+ days old, and flipped back to `active` by the first fetch
  that sees postings; `applyDormancy` also parks scrape-strategy rows after 3 consecutive
  clean zero-yield runs. `broken` is set only by the bot, when `consecutive_failures`
  reaches 5 (`markFetchFailure`); infrastructure faults go through
  `markTransportFailure`, which does not count. There is no `candidate` status anymore.
- **`denied`/`dormant`/`broken` are sticky in the DB.** `upsertCompany` never overwrites
  them from the sheet, so setting a row back to `active` in the tab does nothing, and a
  `broken` row is never fetched again. A row comes back only under a new
  (source, slug) key (a repoint creates a new row and the old one is pruned), by being
  removed from the tab, resynced (pruned), and re-added, or by a direct DB update.
- **Never set `denied`/`dormant` in bulk without the owner's sign-off**: it removes
  companies from scans.

## Environment

- **Node 22+** (`.nvmrc` = 22; uses the experimental built-in `node:sqlite`). Playwright
  needs `npx playwright install chromium`; the `msedge` channel needs Microsoft Edge.
  Development is on **Windows / PowerShell**: prefer cross-platform commands, and in a
  script's main-guard compare `import.meta.url` with `pathToFileURL(process.argv[1]).href`
  (a hand-built `file://` string never matches on Windows).
- **Logs are UTC** (pino). Never compare log timestamps with the local (IST) clock to decide
  a run is stalled.
- **Multi-machine DB sync**: the bot runs on more than one machine, so
  `data/job_hunter.db` is synced through Google Drive with the SAME OAuth client as
  Gmail/Sheets (scope `drive.file`, which sees only files this app created). `npm run once`
  pulls before the tick when Drive is ahead and pushes after it; `db:pull`/`db:push` are the
  manual equivalents. **Adding a scope means re-consenting once per profile**
  (`npm run google-auth -- --profile <name>`): OAuth freezes scopes into the refresh token,
  so until re-consent Drive returns 403, sync logs a warning, and the run continues on the
  local DB. Never run the bot on two machines at once: SQLite has one writer, and a stale
  DB makes `postingExists` miss postings the other machine handled, which drafts duplicate
  emails to recruiters already contacted (`decideBeforeRun` in `src/db/sync.ts` guards
  this). Three invariants, each pinned by a test:
  - **Sync runs before the DB is open.** `db/db.ts` opens the SQLite file at module load,
    and a pull REPLACES that file: with a handle held, the rename fails with `EPERM` on
    Windows and succeeds on Linux while the process keeps reading the replaced file (then
    pushes that stale state back). So `index.ts` must not reach `db/db.ts` through static
    imports; the run body lives in `src/runOnce.ts` and is reached by `await import()`
    after `syncBeforeRun`. `db/openState.ts` lets `pullDb` refuse when the handle is open,
    and `src/__tests__/indexImportGraph.test.ts` fails on any static import that would
    reintroduce it (re-exports included; the `db/index.ts` barrel is all re-exports).
  - **Freshness is judged by content, not mtime.** `db.ts` CREATES the file on import, so a
    fresh machine's empty DB looks *newer* than the real backup. `decideBeforeRun` treats
    "0 postings" as no-local, and `assertPushSafe` refuses to push an empty DB or one under
    half the remote's size (`--force` for a deliberate shrink).
  - **One account owns the backup.** Profiles are separate Google accounts and `drive.file`
    only sees files created under the signed-in one, so an unpinned second profile creates
    a SECOND backup and pulls it over the shared local DB. `DB_SYNC_PROFILE` names the
    owner; other profiles skip sync (`syncSkipReason`).
  After a transfer the local mtime is stamped with the remote's `modifiedTime`, or the next
  run reads "remote-newer" and re-downloads what it just uploaded (5s skew tolerance).
- **Fetch retries have two layers.** Per request, `fetchOk` in `src/ats/http.ts` retries
  429/5xx up to 3 total tries, honoring `Retry-After` (else 1s/2s); the final failure still
  runs the edge-challenge classifier. Tests that stub a single canned 429/5xx must repeat
  it (see `oracle.test.ts`). Per board, the scheduler retries transport faults
  (`config.fetch.transportRetries` = 3, backoff 5s/10s/20s) and parks boards still down for
  one deferred end-of-run pass, worked one at a time, 3s apart. Board-shaped errors (HTTP
  status, schema) never retry. `config.fetch.timeoutMs` is 60s because big paginated boards
  (Bosch, ABB) abort under load at lower values.
- **No-jd postings are rechecked weekly.** A posting stored as `no-jd` (empty or junk JD) is
  otherwise never looked at again, but recruiters often fill the JD in later. While it is still
  listed, `processOnePosting` re-fetches its JD at most once per `config.fetch.noJdRecheckDays`
  (stamped in `postings.jd_checked_at`); a recovered JD runs the normal gauntlet and can notify.
- **Burst-sensitive providers are throttled per provider.** `config.fetch.providerThrottle`
  (currently `workday: { maxConcurrent: 2, minSpacingMs: 4000 }`) caps concurrent boards and
  spaces fetch starts; Workday serves HTML instead of JSON when many boards are hit in a
  burst from one IP, which otherwise miscounts healthy boards as defects.
- **Network outages pause the run; they never skip work.** `src/util/connectivity.ts` runs
  a heartbeat (a 204 probe every 10s, 5s while down) for the whole run, and every outbound
  call (`fetchOk`, `browserFetch.ts` navigation, the Edge-channel adapters,
  OpenRouter, Google REST) does `await awaitNetwork()` first. **The wait is unbounded on
  purpose**: skipping hundreds of boards is far worse than a longer run. Look for "network
  is DOWN" / "still waiting" in the log if a run seems stalled. **A failing request never
  decides the network is down**: it calls `reportNetworkFailure()`, which only asks for an
  immediate probe, and the probe is the arbiter (probe fails -> outage, everything pauses;
  probe succeeds -> that host is refusing us and the run continues). This is what stops a
  WAF-blocked vendor from stalling the sweep, and why there is no "N hosts failed in M
  seconds" threshold. Any response at all (including a 403 page) is `reportNetworkSuccess()`.
  The monitor is started only in `index.ts`, so scripts and tests are unaffected;
  `awaitNetwork()` is a no-op when none is running.
- **Google APIs**: `.env` needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Desktop-app
  OAuth client; a Testing-mode consent screen means refresh tokens die ~weekly, and the
  pre-flight guard names the renew command) and `GOOGLE_SPREADSHEET_ID`. Scopes:
  `gmail.compose`, `gmail.readonly`, `spreadsheets`, `drive.file`. Tokens live at
  `data/google-token-<profile>.json`.
- **LLM backend is OpenRouter only** (`OPENROUTER_API_KEY`; local-LLM support was removed,
  don't propose it back). Default model `deepseek/deepseek-v4-flash-0731`: always a DATED
  slug, since the undated alias points at an older, dearer build and can move mid-sweep.
  Concurrency 8, 30s timeout (`LLM_MAX_CONCURRENT`, `LLM_TIMEOUT_MS`). Pre-flight checks
  the key AND that the slug resolves AND that a pinned provider serves it. Status handling
  is the table in `classifyOpenRouterStatus`: **401** (bad key), **402** (no credits) and
  **404** (no such model) abort the run because they would fail every remaining posting;
  **403** is usually a moderation block on one JD, so it stays per-posting; **429/5xx** are
  retried inside the transport with `Retry-After` so a rate limit never trips the
  backend-down breaker. The prompt goes as ONE user message: splitting it changes the token
  prefix and loses provider-side cache hits. The cache hit-rate is logged every 100 calls
  plus a run total (warns under 50%); cached vs uncached input is ~4x cost. **The cache is
  per upstream provider**, so requests pin `provider.order` to `OPENROUTER_PROVIDERS`
  (default `together,inceptron`) with `allow_fallbacks:false`; letting OpenRouter
  load-balance across its ~20 hosts drove the hit-rate from ~77% to ~3%. Those two are the
  only hosts that passed a 160-call, 8-way-concurrent gate replay with zero wrong verdicts
  (`temp/providerLoadTest.ts`, owner-local); DigitalOcean leaked other in-flight requests'
  JDs into ~1-5% of answers (a hotel receptionist scored 0.9 as "Frontend Engineer" on
  2026-09-07). **Never pin a new host without that load test.**
- The gate judges each posting against the full resume text in the profile dir's
  `resume.txt` (generated from `resume.pdf`; the bot stops if neither exists). A profile's
  `filters.matchThreshold` must exceed its silent floor (`silentFloor`, default
  `SILENT_SCORE_FLOOR` = 0.65) or profile load throws.
