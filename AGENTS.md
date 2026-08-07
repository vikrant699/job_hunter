# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this before making changes.

## What this is

A personal job-hunting bot. It pulls postings from a registry of companies, filters them
against the user's resume and deal-breakers, scores each with a local LLM, then drafts
outreach emails to matching companies' recruiters in the profile's Gmail account (drafts
only - a human reviews and sends). Before drafting, a bounce-only verify pass checks
yesterday's drafts/sent messages against the mailbox (sent/discarded/bounced/verified) so
a known-dead address never gets drafted to again. Both stages project their lifecycle to a
Google Sheet. Discord carries only run status (progress heartbeats + one end-of-run embed).
It is run by hand (`npm run once`), not on a schedule. Not a public service, single user.

## Commands

| Command | What it does |
|---|---|
| `npm run once` | One full sweep: fetch, filter, score, record matches to the Google Sheet, draft outreach emails, post an end-of-run status embed to Discord. Add `-- --profile <name>` for a named profile. |
| `npm test` | Run the test suite (`node:test`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint .` (enforces the type-hygiene rules below). |
| `npm run extract-resume` | Re-extract `config/resume.pdf` to `config/resume.txt`. |
| `npm run google-auth -- --profile <name>` | One-time Google OAuth consent for a profile's Gmail account (writes `data/google-token-<name>.json`). |
| `npm run bootstrap-sheet` | Idempotent outreach-spreadsheet setup: creates bot tabs, seeds Raw Data and Companies from local files when they exist (both are gitignored), writes headers. |
| `npm run verify-outreach -- --profile <name>` | Standalone bounce-only verify pass for one profile's mailbox (sent/discard/bounce/verified), then re-projects the sheet. Runs inside `npm run once` too; this is for checking outside the daily tick. |
| `npm run blast -- --profile <name>` | TEMPORARY weekly cold-email drafter over the Raw Data tab (drafts only, never sends; own JSON state at `data/blast-state-<name>.json`, projects a Blast Log tab). Flags: `--limit N` (default 100), `--verify-only`, `--force`. Delete `src/blast/`, `scripts/blast.ts`, and this row when the campaign ends. |
| `npm run eval` | Replay the labelled eval dataset through the gate. |
| `npm run health` | Read-only registry health report (status/strategy/provider yield tallies from the local DB + cache). |
| `npm run probe \| verify \| scrape` | Other ops/maintenance CLIs under `scripts/`. |

## Before you commit (non-negotiable)

Run all three and confirm clean:

```
npm test            # all green
npx tsc --noEmit    # no errors
npm run lint        # ZERO violations
```

`npm run lint` must stay at **0**. The ESLint config is a guardrail, not a suggestion.

## Type-hygiene rules (enforced by `eslint.config.js`)

1. **No type assertions** except `as const`. No `x as T`, no `x as unknown as T`, no `<T>x`.
   If a value needs to be `T`, fix the upstream type or validate it (rule 4).
2. **No `any`** anywhere, including tests.
3. **No hand-written `unknown`** — now enforced by `@typescript-eslint/no-restricted-types`.
   Where a library hands you an untyped value (`JSON.parse`, `res.json()`, a `node:sqlite`
   row, `page.evaluate`), validate it *at that point* with `JsonValueSchema.parse(...)` and
   carry it as `JsonValue` (rule 6) — do not carry it as `unknown`. The ATS fetch helpers
   (`atsFetchJson`, `atsFetchFormJson`, `atsFetchJsonMultipart`, `browserFetchJson*`) and
   `google/rest.ts` already do this, so every adapter parse function takes `JsonValue`.
   Two carve-outs, both requiring an `eslint-disable-next-line ... -- <reason>`:
   - **Caught/thrown values.** TS types these `unknown` by design and there is no narrower
     type; the predicates in `util/errorCause.ts` exist to narrow them.
   - **Conforming to a library signature** whose parameter is `unknown` (e.g. pino's
     `LogFn`) — narrowing it would break assignability.
   In tests, prefer a generic (`function jsonResponse<T>(body: T)`) over `unknown`, and use
   `asJson(fixture)` from `ats/__tests__/testHelpers.ts` to hand a schema-typed fixture to a
   parser that takes `JsonValue` (it JSON round-trips, dropping `undefined` optionals).
4. **Validate at boundaries, type the interior.** Every place external/untyped data enters
   (DB rows, parsed JSON, HTTP JSON, LLM output) gets a zod schema; the typed value comes from
   `schema.parse(...)` and `type X = z.infer<typeof XSchema>`.
5. **Literal data uses `as const`** (lookup tables, enum-ish arrays, the adapter map) rather
   than a wide type annotation.
6. **Arbitrary JSON walking** (Workday facet tree, Phenom `ddo` island) uses the shared
   `JsonValue`/`JsonValueSchema` in `src/util/json.ts`, narrowed with `typeof` / `Array.isArray`
   / `in`. Never `Record<string, unknown>` or a cast.
7. **Schemas vs types are separated.** Runtime zod schemas live in `src/schemas.ts`;
   `src/types.ts` holds only erasable types and imports inferred enum types from `schemas.ts`.
   Do not put schemas in `types.ts`.
8. **Type imports are their own statement.** `import type { X } from "./x.js";` — never an
   inline `{ value, type X }` mixed import (`consistent-type-imports` with
   `separate-type-imports`, plus a `no-restricted-syntax` selector for the mixed shape).
9. **No TypeScript `enum`.** Use a const object with `as const` and derive the type (rule 5).
10. **Filenames are camelCase** (`unicorn/filename-case`), e.g. `sheetRegistry.ts`,
    `postingPipeline.ts`. `__tests__` / `__mocks__` directories are exempt.
11. **Tests live in `__tests__/`** next to the code they cover — enforced by
    `local/tests-in-tests-folder` from `eslint-local-plugin.js` (ported from core-ui).

## Where things live

```
src/
  ats/         one file per ATS provider; registry.ts = provider->adapter map;
                 http.ts (shared atsFetchJson/atsFetchText); shared.ts (REMOTE_RE,
                 unixToIso, parsePostedOn); htmlText.ts; workdayFacet.ts; types.ts (AtsAdapter);
                 detect.ts (ATS-redirect detection patterns used by llm-scrape)
  db/          per-table modules (companies, postings, runs, recruiters, outreach, link-cache,
                 api-meta) behind a barrel index.ts; db.ts has the singleton + queryAll/queryOne helpers
  filter/      location, title, denylist, verdict
  google/      auth.ts (per-profile token refresh + expiry guard), rest.ts (authorized
                 fetch + retry), sheets.ts, gmail.ts, mime.ts (pure RFC5322 builder)
  llm/         client.ts (provider-agnostic: semaphore, retry, circuit breaker, and the
                 LOCAL dispatch); ollama.ts + openrouter.ts (the two transports);
                 errors.ts (LlmUnavailableError, its own module so both transports can
                 throw it without importing client.ts); gate.ts, extract.ts, shortlist.ts,
                 extractTextJobs.ts, render.ts; prompts/ holds the prompt strings
  pipeline/    index.ts (run lifecycle), scheduler.ts (concurrency), postingPipeline.ts
  discord/     webhook.ts (shared POST/retry), progress.ts (mid-run heartbeat),
                 status.ts (single end-of-run status embed; the progress channel is the
                 ONLY Discord surface - no per-posting pings, no per-profile webhooks)
  outreach/    match.ts (company normalizer + contact matcher), contacts.ts (sheet ->
                 recruiters-table sync), template.ts (+ config/outreach-template.md),
                 run.ts (post-run Gmail draft stage), verify.ts (bounce-only
                 verify pass: draft->sent/discarded, sent->bounced/verified, plus
                 raw-csv recruiter promotion onto the Recruiters List tab),
                 roles.ts (shared roles_json schema), sheetSync.ts (DB -> tab
                 projection), tabs.ts (tab header contracts)
  registry/    sheetRegistry.ts (syncs the Companies tab, with a registry-cache.json
                 fallback, into the DB); companies.ts (shared upsert+prune core, JSON
                 file reader for the cache); sheetCodec.ts (Companies-tab row <->
                 RegistryEntry codec); sheetWriter.ts (Companies-tab mutations:
                 SPA-sentinel strategy flip + appendToRegistry, the blessed write
                 path for registry-maintenance sessions)
  scraper/     cheerio, playwright, llm-scrape, playwright-llm-scrape
  util/        semaphore, sleep, user-agent, slug, json (JsonValue), csv (parse + build),
                 probe, fs (writeFileAtomic), regex (matchGroup), env (envInt)
  schemas.ts   zod schemas + their inferred types
  types.ts     pure types/interfaces
  config.ts profile.ts logger.ts index.ts
config/        profile.ts, resume.* (gitignored); profiles/<name>/ (named multi-profile
                 dirs: profile.ts + resume.*, gitignored)
eval/          offline gate-replay harness (NOT shipped, not in the bot's runtime graph)
scripts/       ops/maintenance CLIs (NOT shipped)
data/          SQLite DB + caches (gitignored)
```

Test files live in a `__tests__/` subdirectory of the module they cover rather than next
to it: `src/ats/foo.ts` is tested by `src/ats/__tests__/foo.test.ts`, and the shared ATS
fixture helpers are at `src/ats/__tests__/testHelpers.ts`. The `npm test` glob
(`src/**/*.test.ts`) matches at any depth, so a new `__tests__` directory needs no config
change.

## Conventions

- **Registry is the Companies tab of the outreach spreadsheet**, the single source of truth.
  It is synced into the SQLite `companies` table each run; the DB is a derived cache.
  `data/registry-cache.json` is a bot-maintained local snapshot/fallback used only when the
  sheet is unreachable, not itself a source of truth. To add/remove a company, edit the tab
  (and check it isn't already present under a non-obvious slug), not the DB or the cache file.
- **Registry appends from maintenance sessions** go through `appendToRegistry` in
  `src/registry/sheetWriter.ts` (dedupes by (source, slug) key and mirrors the local cache);
  never hand-append rows via raw Sheets calls.
- **New ATS adapter (2 wiring points + 1 optional):** implement the `AtsAdapter` interface, then:
  (1) add the provider to the `ProviderSchema` enum in `src/schemas.ts`;
  (2) register the adapter in `src/ats/registry.ts` (`ATS_ADAPTERS`). The map is
  compile-enforced against the enum (`satisfies Record<Exclude<Provider, "custom">, AtsAdapter>`),
  so forgetting either side is a tsc error, and `src/ats/__tests__/registry.test.ts` pins it.
  (3) OPTIONAL: if the vendor has a shared host signature (e.g. `*.vendor.com` tenant
  subdomains), add a `PatternDef` to `src/ats/detect.ts` so llm-scrape's ATS-redirect
  detection can recognize boards that link out to it. No pattern for single-company
  or custom-domain vendors.
  Write fixture tests (TDD) using `src/ats/__tests__/testHelpers.ts` (stubFetch/fetchSequence/
  jsonResponse/mkAdapterCompany). Reuse `atsFetchJson`/`atsFetchText`, `REMOTE_RE`,
  `unixToIso`, and `paginate` from `src/ats/shared.ts`; for WAF/anti-bot hosts use
  `src/ats/browserFetch.ts`.
  There are just over 100 providers now (see `ProviderSchema`); some are browser-backed, and a few
  crack an encrypted payload or lift a token from the page bundle (see `icicibank`, `moglix`,
  `magicpin`, `metacareers`).
- **NEVER truncate a board.** Adapters must page to the end; pagination backstops in
  `src/ats/shared.ts` are runaway guards (5000), not limits. If a board looks capped, find the
  real pagination mechanism.
- **Company `status`:** `active`/`candidate` scan; `denied` = permanently excluded (dead/acquired,
  duplicate-of-another-row, or services/staffing out-of-scope); `dormant` = alive company with no
  reachable board right now, quarantined but revisitable. Never set `denied`/`dormant` in bulk
  without the owner's sign-off - it removes companies from scans.
- **TDD for new logic:** write the failing test first (`node:test`), watch it fail, then implement.
  Refactors must be behavior-preserving (the existing suite is the safety net).
- **Don't reintroduce duplication.** Shared helpers live in `src/util/` and `src/ats/shared.ts`;
  use them.
- **Docs use no em dashes** (use regular hyphens or rephrase). A repo owner preference, applied
  to `README.md` and this file.
- **Commit messages** follow conventional-commit style (`feat:`, `refactor:`, `fix:`, `docs:`,
  `chore:`).

## Environment

- **Node 22+** required (uses the built-in `node:sqlite`, an experimental module).
- **Google APIs (outreach)**: `.env` needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  (Desktop-app OAuth client; consent screen in Testing mode means refresh tokens die
  ~weekly - the bot's pre-flight guard names the renew command) and
  `GOOGLE_SPREADSHEET_ID`. Per-profile tokens live at `data/google-token-<name>.json`.
- **LLM backend** is chosen by `LOCAL` in `.env` (default `true`). Only the exact word
  `false` switches providers - `LOCAL=1`/`yes`/a typo falls back to local, so a slip never
  silently spends money. `client.ts` reads the flag at call time and dispatches to
  `ollama.ts` or `openrouter.ts`; everything above the transport (semaphore, retry,
  breaker, `generate`/`generateOnce`) is shared, so callers never care which is live.
  - `LOCAL=true`: **Ollama** with `qwen3.5:9b` pulled. Concurrency 1 (the GPU serializes),
    90s timeout.
  - `LOCAL=false`: **OpenRouter** (`OPENROUTER_API_KEY`, default model
    `deepseek/deepseek-v4-flash`). Concurrency 8, 30s timeout. 429/5xx are retried inside
    the transport with `Retry-After` so a rate limit never trips the backend-down breaker;
    401/403 aborts the run immediately. The prompt goes as ONE user message - splitting it
    would change the token prefix and lose provider-side prompt-cache hits. The running
    cache hit-rate is logged every 100 calls; watch it, since cached vs uncached input is
    roughly a 4x cost difference.
  - Both override with `LLM_MAX_CONCURRENT` / `LLM_TIMEOUT_MS`.
- The relevance "gate" judges each posting against the full resume text from
  `config/resume.txt` (generated once from `config/resume.pdf`; the bot stops if neither
  exists).
- Development is on **Windows / PowerShell**; prefer cross-platform commands.
