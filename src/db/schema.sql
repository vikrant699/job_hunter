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
  discovered_at         TEXT    NOT NULL,
  last_fetched_at       TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  postings_seen_total   INTEGER NOT NULL DEFAULT 0,
  postings_matched_total INTEGER NOT NULL DEFAULT 0,
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
  llm_relevant   INTEGER,
  llm_reason     TEXT,
  llm_confidence REAL,
  yoe_min        INTEGER,
  yoe_max        INTEGER,
  drop_stage     TEXT,
  notified_at    TEXT,
  PRIMARY KEY (provider, external_id)
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
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  companies_scanned INTEGER,
  postings_seen     INTEGER,
  postings_new      INTEGER,
  postings_notified INTEGER,
  candidates_added  INTEGER,
  error             TEXT
);
