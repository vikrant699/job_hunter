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
| `npm run once` | One full sweep: fetch, filter, score, record matches to the Google Sheet, draft outreach emails, post an end-of-run status embed to Discord. Does NOT run discovery (that is a separate `npm run discover`). Add `-- --profile <name>` for a named profile. |
| `npm run discover` | Discovery only (find new companies; does not touch postings). |
| `npm test` | Run the test suite (`node:test`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint .` (enforces the type-hygiene rules below). |
| `npm run extract-resume` | Re-extract `config/resume.pdf` to `config/resume.txt`. |
| `npm run google-auth -- --profile <name>` | One-time Google OAuth consent for a profile's Gmail account (writes `data/google-token-<name>.json`). |
| `npm run bootstrap-sheet` | Idempotent outreach-spreadsheet setup: creates bot tabs, seeds Raw Data and Companies from local files when they exist (both are gitignored), writes headers. |
| `npm run verify-outreach -- --profile <name>` | Standalone bounce-only verify pass for one profile's mailbox (sent/discard/bounce/verified), then re-projects the sheet. Runs inside `npm run once` too; this is for checking outside the daily tick. |
| `npm run blast -- --profile <name>` | TEMPORARY weekly cold-email drafter over the Raw Data tab (drafts only, never sends; own JSON state at `data/blast-state-<name>.json`, projects a Blast Log tab). Flags: `--limit N` (default 100), `--verify-only`, `--force`. Delete `src/blast/`, `scripts/blast.ts`, and this row when the campaign ends. |
| `npm run eval` | Replay the labelled eval dataset through the gate. |
| `npm run repair-urls` | Probe broken careers URLs and report proposed fixes (dry run). Add `-- --apply --profile <name>` to write fixes straight to the Companies tab (cache mirrored, url_suspect cleared). |
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
3. **No hand-written `unknown`.** Exception: a value a library hands you as `unknown`/`any`
   (a `node:sqlite` row, `JSON.parse`, `res.json()`) may flow *directly* into a
   `zod.parse()`/`.safeParse()` on the same expression. It must not land in a variable or
   annotation you typed as `unknown`/`any`.
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

## Where things live

```
src/
  ats/         one file per ATS provider; registry.ts = provider->adapter map;
                 http.ts (shared atsFetchJson/atsFetchText); shared.ts (REMOTE_RE,
                 unixToIso, parsePostedOn); html-text.ts; workday-facet.ts; types.ts (AtsAdapter)
  db/          per-table modules (companies, postings, runs, quota, link-cache, api-meta)
                 behind a barrel index.ts; db.ts has the singleton + queryAll/queryOne helpers
  discovery/   sources/ (brave, rss, yc); ats-patterns + ats-validate; run.ts; registry-writer.ts
  filter/      location, title, denylist, verdict
  google/      auth.ts (per-profile token refresh + expiry guard), rest.ts (authorized
                 fetch + retry), sheets.ts, gmail.ts, mime.ts (pure RFC5322 builder)
  llm/         client.ts (Ollama); gate.ts, extract.ts, shortlist.ts, extract-text-jobs.ts,
                 render.ts; prompts/ holds the prompt strings (gate, shortlist, extract)
  pipeline/    index.ts (run lifecycle), scheduler.ts (concurrency), posting-pipeline.ts
  discord/     webhook.ts (shared POST/retry), progress.ts (mid-run heartbeat),
                 status.ts (single end-of-run status embed; the progress channel is the
                 ONLY Discord surface - no per-posting pings, no per-profile webhooks)
  outreach/    match.ts (company normalizer + contact matcher), contacts.ts (sheet ->
                 recruiters-table sync), template.ts (+ config/outreach-template.md),
                 run.ts (post-run Gmail draft stage), verify.ts (bounce-only
                 verify pass: draft->sent/discarded, sent->bounced/verified, plus
                 raw-csv recruiter promotion onto the Recruiters List tab),
                 roles.ts (shared roles_json schema), sheet-sync.ts (DB -> tab
                 projection), tabs.ts (tab header contracts)
  registry/    sheet-registry.ts (syncs the Companies tab, with a registry-cache.json
                 fallback, into the DB); companies.ts (shared upsert+prune core, JSON
                 file reader for the cache); sheet-codec.ts (Companies-tab row <->
                 RegistryEntry codec)
  scraper/     cheerio, playwright, llm-scrape, playwright-llm-scrape
  util/        semaphore, user-agent, slug, json (JsonValue), csv (escape/build), probe
  schemas.ts   zod schemas + their inferred types
  types.ts     pure types/interfaces
  config.ts profile.ts logger.ts index.ts
config/        profile.ts, resume.* (gitignored); profiles/<name>/ (named multi-profile
                 dirs: profile.ts + resume.*, gitignored)
eval/          offline gate-replay harness (NOT shipped, not in the bot's runtime graph)
scripts/       ops/maintenance CLIs (NOT shipped)
data/          SQLite DB + caches (gitignored)
```

## Conventions

- **Registry is the Companies tab of the outreach spreadsheet**, the single source of truth.
  It is synced into the SQLite `companies` table each run; the DB is a derived cache.
  `data/registry-cache.json` is a bot-maintained local snapshot/fallback used only when the
  sheet is unreachable, not itself a source of truth. To add/remove a company, edit the tab
  (and check it isn't already present under a non-obvious slug), not the DB or the cache file.
- **New ATS adapter (4-file wiring):** implement the `AtsAdapter` interface, then wire it into
  all four: (1) add the provider to the `ProviderSchema` enum in `src/schemas.ts`; (2) register
  the adapter in `src/ats/registry.ts` (`ATS_ADAPTERS`); (3) add it to the `AtsProvider` union +
  `CAPABILITIES` in `src/discovery/ats-patterns.ts` (`hasAdapter: true`; `canValidate: true` + a
  host `PATTERN` only if there's a derivable host signature, else `canValidate: false` and no
  pattern - mirror `jibe`/`eightfoldpcs`); (4) if `canValidate: true`, add a `case` in
  `src/discovery/ats-validate.ts`. Write fixture tests (TDD). Reuse `atsFetchJson`/`atsFetchText`,
  `REMOTE_RE`, `unixToIso`, and the location helpers from `src/ats/shared.ts` rather than
  re-rolling them; for WAF/anti-bot hosts use the browser-backed helpers in
  `src/ats/browser-fetch.ts` (shared headless-Chromium pool) instead of adding evasion code.
  There are ~70 providers now; some are browser-backed, and a few crack an encrypted payload or
  lift a token from the page bundle (see `icicibank`, `moglix`, `magicpin`, `metacareers`).
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
- **Ollama** runs locally with `qwen3.5:9b` pulled; the relevance "gate" judges each posting
  against the full resume text from `config/resume.txt` (generated once from `config/resume.pdf`;
  the bot stops if neither exists).
- Development is on **Windows / PowerShell**; prefer cross-platform commands.
