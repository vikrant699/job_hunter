# job-hunter-bot

A personal job-hunting bot. It pulls postings from a list of companies you curate, filters
them against your profile and resume, scores each with an LLM, and drafts outreach emails
to the matching companies' recruiters in your Gmail (drafts only: you review and send).
Results are tracked in a Google Sheet; Discord, if configured, gets run status only.

You run it by hand with `npm run once`. A full sweep over ~1,700 active companies takes
roughly half an hour and costs well under a dollar in LLM calls.

Contributing, or pointing an AI agent at this repo? Read [AGENTS.md](AGENTS.md).

## Requirements

- Node 22+ (uses the built-in `node:sqlite`).
- An [OpenRouter](https://openrouter.ai/keys) API key (prepaid credits).
- A Google account plus a Google Cloud **Desktop-app OAuth client** (Gmail + Sheets + Drive
  APIs enabled). The bot will not start without a valid Google token.
- A Google Sheet to act as the bot's database front-end (company list, recruiter contacts,
  draft tracking).
- Your resume as a PDF.
- Optional: a Discord webhook for run status.

## Setup

**1. Install.**

```
git clone <your-fork>
cd job_hunter
npm install
npx playwright install chromium
cp .env.example .env
cp config/profile.example.ts config/profile.ts
```

Some boards need Microsoft Edge installed (built in on Windows); they fail on their own
without it and the rest of the run is unaffected.

**2. Fill in `.env`.** Every variable is commented in `.env.example`. The required ones:

| Variable | What |
|---|---|
| `OPENROUTER_API_KEY` | Your OpenRouter key. Leave `OPENROUTER_MODEL` / `OPENROUTER_PROVIDERS` at their defaults unless you know why (they are pinned for prompt caching and answer quality). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Desktop-app OAuth client (Cloud Console > APIs & Services > Credentials). |
| `GOOGLE_SPREADSHEET_ID` | The long id in your sheet's URL. |

**3. Authorize Google.** Opens a browser for consent and writes `data/google-token-default.json`:

```
npm run google-auth
```

If your OAuth consent screen is in Testing mode, the token expires about weekly; the bot
tells you when, and you rerun this command.

**4. Prepare the sheet.** In the spreadsheet, create a tab named `Recruiters List` with
the header row `Company | Name | Phone | Email` (columns A-D). Then run:

```
npm run bootstrap-sheet
```

This creates the `Raw Data`, `Drafts`, `Sent`, `Undrafted` and `Companies` tabs, writes
their headers, and adds the bot's columns (E-G) to `Recruiters List`. It is safe to rerun;
tabs that already have data are left alone.

**5. Add companies** to the `Companies` tab (see [The company list](#the-company-list)).
On a fresh setup it is empty, so there is nothing to scan until you add rows.

**6. Add recruiter contacts** (for outreach) to `Recruiters List` (one row per contact),
or as bulk rows in `Raw Data` (`company, email, contact_name, alt_names, flags, seen`).
Contacts are matched to a posting's company by name (spelled as in the `Companies` tab),
then by `alt_names` (`;`-separated), then by email domain. Matches with no contact are
still recorded, on the `Undrafted` tab.

**7. Your profile and resume.**

- Put your resume at `config/resume.pdf`. It is extracted to `config/resume.txt` on the
  first run (and again whenever the PDF is newer); the LLM judges every posting against it.
- Edit `config/profile.ts`: target roles and cities, experience limits, deal-breakers,
  title filters, and company denylists. Each field is commented. The shipped example is a
  data-analyst search in India; replace it. Optional fields: `senderName`, `senderLinks`
  and `profilePitch` (used in the outreach email), `gatePrompt` (replaces the scoring
  prompt), `filters.silentFloor` (score below which a posting is dropped, default 0.65;
  `matchThreshold` must be above it), and `neverSilenceTitlePatterns`.
- Edit `config/outreach-template.md` if you want different email wording. Placeholders:
  `{{company}}`, `{{roles_block}}`, `{{role_summary}}`, `{{s_if_plural}}`,
  `{{contact_name_or_there}}`, `{{profile_pitch}}`, `{{sender_name}}`, `{{sender_links}}`.
  Your resume PDF is attached to every draft.

**8. Optional:** set `DISCORD_PROGRESS_WEBHOOK_URL` in `.env` for run status.

`.env`, `config/profile.ts`, `config/resume.*`, `config/profiles/` and `data/` are
gitignored and stay on your machine.

## Running

```
npm run once
```

A run does, in order:

1. Pre-flight: checks the OpenRouter key and model, and your Google token. Fails in seconds
   if either is wrong.
2. Pulls a newer DB from Google Drive if one exists (see below), then syncs the
   `Companies` tab into the local SQLite DB (`data/job_hunter.db`).
3. Fetches every active company's board, drops postings outside your locations or title
   filters (and anything already seen), then asks the LLM to score the rest. Each posting
   ends up **green** (strong match), **yellow** (borderline, a soft deal-breaker, or
   unclear experience requirement) or silently dropped.
4. Checks yesterday's drafts against your mailbox (sent, discarded, bounced), then drafts
   one email per matching company and recruiter. A recruiter is not re-drafted within 30 days.
5. Updates the sheet: `Drafts` and `Sent` (one row per company/recruiter, with roles,
   green/yellow severity and score), `Undrafted` (matches that got no draft, and why).
6. Posts one status summary to Discord (or logs it).

Then open Gmail, review the drafts, and send the ones you like.

If your connection drops mid-run, the run pauses and resumes by itself; look for
"network is DOWN" in the log. Logs are timestamped in UTC.

## The company list

The `Companies` tab is the source of truth. The DB copy is rebuilt from it every run, so
edit the sheet, never the DB. Columns, in order:

`name, careers_url, source, source_slug, parsing_strategy, status, reason, discovered_via,
discovered_at, evidence, tenant_url, api_meta, category, employer_type`

Only the first five are required. Example:

| name | careers_url | source | source_slug | parsing_strategy |
|---|---|---|---|---|
| Acme | https://acme.example.com/careers | greenhouse | acme | ats-api |

- `source` is the job-board vendor (121 supported; see `ProviderSchema` in
  `src/schemas.ts`). `npm run probe -- acme` checks Greenhouse, Lever and Ashby for a
  matching slug; for other vendors, open the careers page and look where the job links go.
- Workday rows also need `tenant_url`, e.g. `https://acme.wd1.myworkdayjobs.com/External`.
- `parsing_strategy` is `ats-api` for any supported vendor. For a careers page with no
  supported vendor, use source `custom` with `llm-scrape` (plain HTML) or
  `playwright-llm-scrape` (JavaScript-rendered). `manual` keeps a row on the list without
  fetching it.
- `status`: blank or `active` is scanned. `denied` is never scanned (dead, duplicate, or out
  of scope). `dormant` is a real company with no reachable board, rechecked weekly and
  reactivated automatically once it lists jobs. Separately, the bot marks a company
  `broken` in its DB (not the sheet) after 5 consecutive failed fetches and stops scanning
  it; `npm run health` counts them.
- Once the DB holds a row as `denied`, `dormant` or `broken`, setting it back to `active`
  in the sheet does not revive it. Changing its `source`/`source_slug` does (that is a new
  row). Otherwise, delete the row from the sheet, run `npm run resync-registry`, then add it
  back and resync again.
- `category` and `employer_type` (`product`/`service`) are curation labels; the bot does
  not filter on them.

## Commands

| Command | What it does |
|---|---|
| `npm run once` | One full run (above). |
| `npm run google-auth` | Google consent; rerun when the token expires. |
| `npm run bootstrap-sheet` | Create/prepare the sheet's tabs. Idempotent. |
| `npm run extract-resume` | Re-extract the resume PDF to text (also automatic when the PDF is newer). |
| `npm run verify-outreach` | Just the mailbox check (sent/discarded/bounced) plus sheet update. |
| `npm run probe -- <name> [<name>...]` | Guess a company's Greenhouse/Lever/Ashby slug. |
| `npm run probe-url -- <url> [--gate]` | Why isn't this job in my results? Shows what the bot knows about that posting and its board. `--gate` also scores it (one LLM call). |
| `npm run scrape -- <slug>` | Debug the `llm-scrape` path for one company. |
| `npm run verify [-- --suggest]` | Check every company's board is reachable (uses the local cache, so run `once` first). `--suggest` tries other vendors for failures. |
| `npm run health` | Read-only report: company counts by status/strategy/vendor, failure streaks, yield. |
| `npm run resync-registry` | Pull the `Companies` tab into the DB without doing a run. |
| `npm run db:push` / `npm run db:pull` | Copy the DB to/from Google Drive (see below). |
| `npm test` / `npm run typecheck` / `npm run lint` | Test suite, type check, lint. |

Every command that touches Google or a profile takes `-- --profile <name>`.

## Multiple profiles

To run separate searches (two people, or two role families), create
`config/profiles/<name>/profile.ts` plus `resume.pdf` in the same folder, authorize it with
`npm run google-auth -- --profile <name>` (its own Google account), and run
`npm run once -- --profile <name>` (or set `PROFILE=<name>`). Profiles share the company
list and DB; results are stamped per profile. Without `--profile`, the bot uses
`config/profile.ts`.

## Multiple machines

`npm run once` pulls the DB from your Google Drive before a run when Drive has a newer
copy, and pushes it back afterwards. With more than one profile, set `DB_SYNC_PROFILE` to
the one profile whose account holds the backup. Never run on two machines at once: a stale
DB drafts duplicate emails. `db:push`/`db:pull` refuse unsafe transfers (older, empty, or
much smaller copies); `--force` overrides.

## Troubleshooting

- **"Google auth expired"**: `npm run google-auth [-- --profile <name>]`.
- **Drive returns 403**: your token predates the Drive scope; rerun `google-auth` once.
- **A company returns nothing**: `npm run probe-url -- <a job URL from their site>`, then
  check its row in `npm run health`.
- **"llm prompt-cache hit rate is low"** at the end of a run: `OPENROUTER_PROVIDERS` was
  changed or a pinned host dropped the model; runs cost more until it is fixed.

## License

MIT. See [LICENSE](LICENSE).
