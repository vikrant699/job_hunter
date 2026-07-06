CREATE TABLE IF NOT EXISTS companies (
  provider              TEXT    NOT NULL,
  slug                  TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  careers_url           TEXT    NOT NULL,
  parsing_strategy      TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'candidate',
  deny_reason           TEXT,
  discovered_via        TEXT,
  tenant_url            TEXT,
  api_meta              TEXT,
  discovered_at         TEXT    NOT NULL,
  last_fetched_at       TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  postings_seen_total   INTEGER NOT NULL DEFAULT 0,
  postings_matched_total INTEGER NOT NULL DEFAULT 0,
  zero_yield_streak     INTEGER NOT NULL DEFAULT 0,  -- consecutive clean fetches that saw 0 raw postings
  url_suspect           INTEGER NOT NULL DEFAULT 0,  -- 1 = fetched OK but page doesn't look like a careers page
  PRIMARY KEY (provider, slug)
);

CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

CREATE TABLE IF NOT EXISTS postings (
  provider       TEXT    NOT NULL,
  external_id    TEXT    NOT NULL,
  company_slug   TEXT    NOT NULL,
  job_title      TEXT,
  job_url        TEXT    NOT NULL,
  location       TEXT,
  is_remote      INTEGER NOT NULL DEFAULT 0,
  jd_text        TEXT,
  posted_at      TEXT,
  discovered_at  TEXT    NOT NULL,
  profile_id     TEXT    NOT NULL DEFAULT 'default',
  llm_relevant   INTEGER,
  llm_reason     TEXT,
  llm_confidence REAL,
  yoe_min        REAL,    -- fractional YOE like 4.5 is valid
  yoe_max        REAL,
  drop_stage     TEXT,
  notified_at    TEXT,
  PRIMARY KEY (provider, external_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_postings_company ON postings(provider, company_slug);
CREATE INDEX IF NOT EXISTS idx_postings_discovered ON postings(discovered_at);

CREATE TABLE IF NOT EXISTS brave_quota (
  month  TEXT PRIMARY KEY,   -- "YYYY-MM"
  count  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS link_cache (
  provider    TEXT NOT NULL,
  slug        TEXT NOT NULL,
  links_json  TEXT NOT NULL,
  cached_at   TEXT NOT NULL,
  PRIMARY KEY (provider, slug)
);

CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,
  profile_id        TEXT NOT NULL DEFAULT 'default',
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  companies_scanned INTEGER,
  postings_seen     INTEGER,
  postings_new      INTEGER,
  postings_notified INTEGER,
  candidates_added  INTEGER,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS recruiters (
  email             TEXT PRIMARY KEY,          -- lowercased
  company           TEXT NOT NULL,
  company_norm      TEXT NOT NULL,
  alt_names_norm    TEXT,                      -- ';'-joined normalized alt names
  contact_name      TEXT,
  phone             TEXT,
  source            TEXT NOT NULL,             -- 'raw-csv' | 'manual-sheet'
  registry_provider TEXT,
  registry_slug     TEXT,
  status            TEXT NOT NULL DEFAULT 'unverified',  -- unverified|verified|bounced (GLOBAL)
  verified_at       TEXT,
  imported_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruiters_company ON recruiters(company_norm);

CREATE TABLE IF NOT EXISTS outreach (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id        TEXT NOT NULL DEFAULT 'default',
  recruiter_email   TEXT NOT NULL,
  company_name      TEXT NOT NULL,
  roles_json        TEXT NOT NULL,             -- [{title, jobUrl, severity, score}]
  run_id            INTEGER,
  run_date          TEXT NOT NULL,             -- YYYY-MM-DD (IST)
  gmail_draft_id    TEXT,
  gmail_thread_id   TEXT,
  gmail_message_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft|discarded|sent|bounced|verified
  drafted_at        TEXT NOT NULL,
  sent_at           TEXT,
  verified_at       TEXT,
  last_checked_at   TEXT,
  failure_detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status);
CREATE INDEX IF NOT EXISTS idx_outreach_cooldown ON outreach(recruiter_email, profile_id, drafted_at);

CREATE TABLE IF NOT EXISTS undrafted (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL DEFAULT 'default',
  run_id     INTEGER,
  run_date   TEXT NOT NULL,
  company    TEXT NOT NULL,
  job_title  TEXT NOT NULL,
  location   TEXT,
  job_url    TEXT NOT NULL,
  severity   TEXT NOT NULL,
  score      REAL,
  reason     TEXT NOT NULL  -- no_contact|cooldown|bounced_contact|draft_discarded
);
