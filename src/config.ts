// Runtime knobs that aren't user-specific; personal stuff lives in config/profile.ts.
import { GATE_PROMPT } from "./llm/prompts/gate.js";
import { SHORTLIST_PROMPT, SHORTLIST_FROM_TEXT_PROMPT } from "./llm/prompts/shortlist.js";
import { EXTRACT_PROMPT } from "./llm/prompts/extract.js";
import { envInt } from "./util/env.js";

// Typed `number` (not `as const`-narrowed) so scheduler.ts's skip-if-disabled checks stay real runtime checks.
const INTER_CALL_DELAY_MS: number = 250;
const DEFERRED_PASS_PACE_MS: number = 3_000;

/** Per-provider start throttle: caps concurrent/spacing of a provider's board fetches so Workday's edge doesn't misclassify healthy boards as failures under burst load. */
export interface ProviderThrottle {
  maxConcurrent: number;
  minSpacingMs: number;
}

// Values are `as const` (Standard rule 5); the table itself is typed for arbitrary-string lookup (Standard rule 1: no casts) so scheduler.ts can index it by a live `company.provider` without narrowing every provider to a table key.
const PROVIDER_THROTTLE_TABLE: Partial<Record<string, ProviderThrottle>> = {
  workday: { maxConcurrent: 2, minSpacingMs: 4000 },
} as const;

export const config = {
  fetch: {
    /** How many companies of one provider run in parallel. */
    concurrencyPerProvider: 4,
    /** Postings processed in parallel inside one company. LLM calls are capped separately by the semaphore in llm/client.ts. */
    workersPerCompany: 5,
    /** Politeness delay between worker-pool iterations within a company. */
    interCallDelayMs: INTER_CALL_DELAY_MS,
    /** Big paginated boards (Bosch, ABB) get aborted mid-fetch under load at lower timeouts. */
    timeoutMs: 60_000,
    /** Retries transport-layer failures only (see util/errorCause.ts); board-shaped errors (HTTP status, schema) never retry. */
    transportRetries: 3,
    /** First transport backoff; doubles per attempt (5s, 10s, 20s). */
    transportRetryBaseMs: 5_000,
    /** End-of-run deferred pass works boards one at a time, spaced, not at concurrencyPerProvider - some ATS edges throttle bursts. */
    deferredPassPaceMs: DEFERRED_PASS_PACE_MS,
    /** Identify ourselves to ATS providers; some block default node UA. */
    userAgent: "job-hunter-bot/0.1",
    /** Providers with a start throttle (see ProviderThrottle above); absent = no throttle, unaffected. */
    providerThrottle: PROVIDER_THROTTLE_TABLE,
  },

  llm: {
    /** Required; llm/client.ts pre-flight fails fast if missing. */
    openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
    /** Pinned to a dated snapshot so the model can't change under a run's feet; pre-flight verifies it still resolves. */
    openRouterModel: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash-0731",
    openRouterUrl: "https://openrouter.ai/api/v1/chat/completions",
    /** Timeout starts after the semaphore slot is acquired, so it measures generation, not queue wait. */
    timeoutMs: envInt("LLM_TIMEOUT_MS", 30_000),
    maxRetries: 2,
    /** Concurrent LLM calls in flight; override with LLM_MAX_CONCURRENT. */
    maxConcurrent: envInt("LLM_MAX_CONCURRENT", 8),
    /** Caps JD text per prompt to bound per-call cost. */
    jdMaxChars: 18000,
  },

  prompts: {
    gate: GATE_PROMPT,
    shortlist: SHORTLIST_PROMPT,
    shortlistFromText: SHORTLIST_FROM_TEXT_PROMPT,
    extract: EXTRACT_PROMPT,
  },

  network: {
    /** Neutral and tiny (HTTP 204); answers "do we have a connection", not "is any board healthy". */
    probeUrl: process.env.NETWORK_PROBE_URL ?? "https://www.google.com/generate_204",
    probeTimeoutMs: envInt("NETWORK_PROBE_TIMEOUT_MS", 5_000),
    probeIntervalMs: envInt("NETWORK_PROBE_INTERVAL_MS", 10_000),
    /** Tighter during an outage so the run resumes promptly once it's back. */
    probeDownIntervalMs: envInt("NETWORK_PROBE_DOWN_INTERVAL_MS", 5_000),
  },

  storage: {
    /** Overridable so tests point at a throwaway DB; outreach sheet-sync mirrors tables onto the real Google Sheet. */
    dbPath: process.env.JOB_HUNTER_DB_PATH ?? "data/job_hunter.db",
    /** Local snapshot of the Companies tab (sheet is the source of truth); read back only when the sheet is unreachable. */
    registryPath: "data/registry-cache.json",
  },

  discord: {
    /** Prefix on every embed title — useful when sharing a channel with other bots. */
    titlePrefix: "[job-hunter]",
    /** Shared channel for the bot's run status: mid-run progress heartbeats + the
     *  end-of-run status embed (all profiles post here). Unset → mock mode. */
    progressWebhookUrl: process.env.DISCORD_PROGRESS_WEBHOOK_URL,
    /** How often to post a progress heartbeat during a (long) production tick. */
    progressIntervalMs: 15 * 60 * 1000,
  },

  google: {
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID ?? "",
    /** Per-profile token written by scripts/googleAuth.ts. */
    tokenPathFor: (profileId: string) => `data/google-token-${profileId}.json`,
    scopes: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      // drive.file: access only to files this app creates, used to sync data/job_hunter.db between machines (db/sync.ts).
      "https://www.googleapis.com/auth/drive.file",
    ],
    driveDbFileName: "job_hunter.db",
    /** Owning profile for the Drive backup; empty = unpinned. An unpinned second profile would create its own backup and clobber the shared DB. */
    driveSyncProfile: process.env.DB_SYNC_PROFILE ?? "",
    tabs: {
      rawData: "Raw Data",
      recruiters: "Recruiters List",
      drafts: "Drafts",
      sent: "Sent",
      undrafted: "Undrafted",
      companies: "Companies",
    },
  },

  instahyre: {
    /** Navigation timeout for the opportunities feed. */
    navTimeoutMs: envInt("INSTAHYRE_NAV_TIMEOUT_MS", 45_000),
    /** Bound on every login/feed-state wait; also what decides "no matching jobs" vs a real hang. */
    feedTimeoutMs: envInt("INSTAHYRE_FEED_TIMEOUT_MS", 25_000),
    /** Sleep between apply/confirm clicks, matching the source bot's pacing. */
    clickIntervalMs: 3_000,
    /** Runaway guard, not a target - the loop normally stops when the feed runs out. */
    maxApplications: envInt("INSTAHYRE_MAX_APPLICATIONS", 300),
    /** Wall-clock budget for the apply loop so a stuck feed can't block npm run once indefinitely. */
    stepBudgetMs: envInt("INSTAHYRE_STEP_BUDGET_MS", 15 * 60_000),
  },

  outreach: {
    cooldownDays: 30,
    verifyAfterHours: 24,
    draftSeverities: ["green", "yellow"],
    templatePath: "config/outreach-template.md",
    attachResume: true,
  },
} as const;

/** Looks up a provider's start throttle, if any; `table` defaults to config's but is injectable for tests. */
export function throttleFor(
  provider: string,
  table: Partial<Record<string, ProviderThrottle>> = config.fetch.providerThrottle,
): ProviderThrottle | undefined {
  return table[provider];
}
