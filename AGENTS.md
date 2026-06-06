# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this before making changes.

## What this is

A personal job-hunting bot. It pulls postings from a registry of companies, filters them
against the user's resume and deal-breakers, scores each with a local LLM, and notifies the
good matches to Discord. It is run by hand (`npm run once`), not on a schedule. Not a public
service, single user.

## Commands

| Command | What it does |
|---|---|
| `npm run once` | One full sweep: fetch, filter, score, notify, discovery, daily CSV report. |
| `npm run discover` | Discovery only (find new companies; does not touch postings). |
| `npm test` | Run the test suite (`node:test`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `eslint .` (enforces the type-hygiene rules below). |
| `npm run extract-resume` | Re-extract `config/resume.pdf` to `config/resume.txt`. |
| `npm run eval` | Replay the labelled eval dataset through the gate. |
| `npm run probe \| verify \| scrape \| repair-urls` | Ops/maintenance CLIs under `scripts/`. |

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
  discovery/   sources/ (brave, rss, yc); ats-patterns + ats-validate; run.ts; json-writer.ts
  filter/      location, title, denylist, verdict
  llm/         client.ts (Ollama); gate.ts, extract.ts, shortlist.ts, extract-text-jobs.ts,
                 render.ts; prompts/ holds the prompt strings (gate, shortlist, extract)
  pipeline/    index.ts (run lifecycle), scheduler.ts (concurrency), posting-pipeline.ts
  reports/     daily-csvs.ts          discord/  attachments.ts (CSV+upload), notify.ts
  registry/    companies.ts (syncs config/companies.json into the DB)
  scraper/     cheerio, playwright, llm-scrape, playwright-llm-scrape
  util/        semaphore, user-agent, slug, json (JsonValue)
  schemas.ts   zod schemas + their inferred types
  types.ts     pure types/interfaces
  config.ts profile.ts logger.ts index.ts
config/        companies.json (registry source of truth); profile.ts, resume.* (gitignored)
eval/          offline gate-replay harness (NOT shipped, not in the bot's runtime graph)
scripts/       ops/maintenance CLIs (NOT shipped)
data/          SQLite DB + caches (gitignored)
```

## Conventions

- **Registry is `config/companies.json`**, the single source of truth. It is synced into the
  SQLite `companies` table each run; the DB is a derived cache. To add/remove a company, edit
  the JSON (and check it isn't already present under a non-obvious slug), not the DB.
- **New ATS adapter:** implement the `AtsAdapter` interface, register it in `src/ats/registry.ts`,
  and add fixture tests. Reuse `atsFetchJson`/`atsFetchText`, `REMOTE_RE`, `unixToIso`,
  `buildLocationString`-style helpers from `src/ats/shared.ts` rather than re-rolling them.
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
- **Ollama** runs locally with `qwen3.5:9b` pulled; the relevance "gate" judges each posting
  against the full resume text from `config/resume.txt` (generated once from `config/resume.pdf`;
  the bot stops if neither exists).
- Development is on **Windows / PowerShell**; prefer cross-platform commands.
