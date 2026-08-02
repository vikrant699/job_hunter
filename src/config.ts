/**
 * Application config — runtime knobs that aren't user-specific.
 *
 * Personal stuff (your resume, deal-breakers, target locations, title-deny
 * patterns, services denylist) lives in `config/profile.ts` instead.
 */
import { GATE_PROMPT } from "./llm/prompts/gate.js";
import { SHORTLIST_PROMPT, SHORTLIST_FROM_TEXT_PROMPT } from "./llm/prompts/shortlist.js";
import { EXTRACT_PROMPT } from "./llm/prompts/extract.js";
import { envInt } from "./util/env.js";

// Both delays are compared against 0 by pipeline/scheduler.ts to skip the sleep
// when they are disabled, so both are declared outside the `as const` config
// object (typed `number`, not narrowed to their literals) to keep those
// skip-if-disabled checks real runtime checks rather than
// compile-time-always-true ones.
const INTER_CALL_DELAY_MS: number = 250;
const DEFERRED_PASS_PACE_MS: number = 3_000;

export const config = {
  fetch: {
    /** How many companies of one provider run in parallel. */
    concurrencyPerProvider: 4,
    /** Postings processed in parallel inside one company. HTTP fans out;
     *  Ollama serializes via the semaphore in llm/client.ts. */
    workersPerCompany: 5,
    /** Politeness delay between worker-pool iterations within a company. */
    interCallDelayMs: INTER_CALL_DELAY_MS,
    /** Per-call timeout for ATS fetches. Raised 20s -> 60s (2026-07-23): big
     *  paginated boards (Bosch ~24s, ABB ~30s) were being aborted mid-fetch under
     *  load, dropping their entire posting set. See config-repair memory. */
    timeoutMs: 60_000,
    /** Retries for transport-layer failures only (DNS/socket — see
     *  util/error-cause.ts). Board-shaped errors (HTTP status, schema) are never
     *  retried. 3 retries at the base delay below span ~35s, which covers a brief
     *  blip; anything longer is caught by the end-of-run deferred pass. */
    transportRetries: 3,
    /** First transport backoff; doubles per attempt (5s, 10s, 20s). */
    transportRetryBaseMs: 5_000,
    /** Gap between boards in the end-of-run deferred pass, which works them one
     *  at a time rather than at concurrencyPerProvider. Provenance: run 31
     *  (2026-08-01) lost 17 Workday tenants to a 24-second edge throttle, and
     *  re-probing those boards by hand SEQUENTIALLY, 2.5s apart, got jobs from 17
     *  of 19 (909 India postings) — so sequential-and-spaced is the shape the
     *  vendor tolerates, and this sits just above the spacing that worked. The
     *  pass only ever handles the boards a run deferred (8 in run 31), and runs
     *  after every bucket is done, so the added latency is nearly free: even 17
     *  boards is under a minute. */
    deferredPassPaceMs: DEFERRED_PASS_PACE_MS,
    /** Identify ourselves to ATS providers; some block default node UA. */
    userAgent: "job-hunter-bot/0.1",
  },

  llm: {
    ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    /** Model to use. Pull once: `ollama pull qwen3.5:9b`. Override via OLLAMA_MODEL. */
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
    /** Timeout starts AFTER the semaphore slot is acquired (measures generation, not queue wait). */
    timeoutMs: 90_000,
    maxRetries: 2,
    /** Only raise above 1 if running multiple Ollama instances behind a load balancer. */
    maxConcurrent: 1,
    /** Context window (tokens). Pair with OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0
     *  so the KV cache fits in VRAM alongside model weights. jdMaxChars is sized to this. */
    numCtx: envInt("OLLAMA_NUM_CTX", 9000),
    // max chars of JD/text sent to the model
    jdMaxChars: 18000,
  },

  prompts: {
    gate: GATE_PROMPT,
    shortlist: SHORTLIST_PROMPT,
    shortlistFromText: SHORTLIST_FROM_TEXT_PROMPT,
    extract: EXTRACT_PROMPT,
  },

  storage: {
    /** Overridable so the test runner points at a throwaway DB (test-setup.mjs).
     *  Tests used to write fixture rows into the production DB — harmless while
     *  nothing projected DB state outward, but the outreach sheet-sync now
     *  mirrors outreach tables onto the user's real Google Sheet. */
    dbPath: process.env.JOB_HUNTER_DB_PATH ?? "data/job_hunter.db",
    /** LOCAL SNAPSHOT of the Companies tab (the registry source of truth),
     *  not itself a source of truth. Written atomically after every fully-
     *  valid sheet sync; read back only when the sheet is unreachable
     *  (sheet-registry.ts) or by read-only ops scripts. */
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
    /** Per-profile token written by scripts/google-auth.ts. */
    tokenPathFor: (profileId: string) => `data/google-token-${profileId}.json`,
    scopes: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    tabs: {
      rawData: "Raw Data",
      recruiters: "Recruiters List",
      drafts: "Drafts",
      sent: "Sent",
      undrafted: "Undrafted",
      companies: "Companies",
    },
  },

  outreach: {
    cooldownDays: 30,
    verifyAfterHours: 24,
    draftSeverities: ["green", "yellow"],
    templatePath: "config/outreach-template.md",
    attachResume: true,
  },
} as const;
