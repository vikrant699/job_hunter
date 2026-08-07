/**
 * Application config — runtime knobs that aren't user-specific.
 *
 * Personal stuff (your resume, deal-breakers, target locations, title-deny
 * patterns, services denylist) lives in `config/profile.ts` instead.
 */
import { GATE_PROMPT } from "./llm/prompts/gate.js";
import { SHORTLIST_PROMPT, SHORTLIST_FROM_TEXT_PROMPT } from "./llm/prompts/shortlist.js";
import { EXTRACT_PROMPT } from "./llm/prompts/extract.js";
import { envInt, envBool } from "./util/env.js";

// Both delays are compared against 0 by pipeline/scheduler.ts to skip the sleep
// when they are disabled, so both are declared outside the `as const` config
// object (typed `number`, not narrowed to their literals) to keep those
// skip-if-disabled checks real runtime checks rather than
// compile-time-always-true ones.
const INTER_CALL_DELAY_MS: number = 250;
const DEFERRED_PASS_PACE_MS: number = 3_000;

// Hoisted because the llm block reads it three times (transport dispatch plus
// the two knobs whose sane default differs per provider). envBool returns
// `boolean`, not a literal, so `as const` does not narrow config.llm.local into
// a compile-time-constant comparison the way a bare `true` would.
const LLM_LOCAL = envBool("LOCAL", true);

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
     *  util/errorCause.ts). Board-shaped errors (HTTP status, schema) are never
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
    /** Which transport llm/client.ts dispatches to. true = local Ollama (the
     *  default, and what every existing .env gets); false = OpenRouter. Only the
     *  exact word "false" flips it - see envBool. */
    local: LLM_LOCAL,
    ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    /** Model to use. Pull once: `ollama pull qwen3.5:9b`. Override via OLLAMA_MODEL. */
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
    /** OpenRouter (LOCAL=false). Key is required only when local is false; the
     *  pre-flight in llm/client.ts fails fast with the fix if it is missing. */
    openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
    /** Pinned to a dated snapshot on purpose. The undated `deepseek/deepseek-v4-flash`
     *  alias still resolves, but to the older 0423 build - which is also 55% dearer
     *  ($0.14/M in vs $0.09/M). A dated slug means the model cannot change under a
     *  run's feet, and the pre-flight verifies it still resolves. */
    openRouterModel: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash-0731",
    openRouterUrl: "https://openrouter.ai/api/v1/chat/completions",
    /** Timeout starts AFTER the semaphore slot is acquired (measures generation, not queue wait).
     *  90s locally covers a cold prefill on a busy GPU; a hosted call that has not
     *  answered in 30s is hung, and holding a concurrency slot for it just wastes throughput. */
    timeoutMs: envInt("LLM_TIMEOUT_MS", LLM_LOCAL ? 90_000 : 30_000),
    maxRetries: 2,
    /** Ollama serializes on the GPU, so 1 is right locally (raise only if running
     *  multiple instances behind a load balancer). A hosted API has no such
     *  constraint, so LOCAL=false defaults to 8. Override with LLM_MAX_CONCURRENT. */
    maxConcurrent: envInt("LLM_MAX_CONCURRENT", LLM_LOCAL ? 1 : 8),
    /** Context window (tokens). Pair with OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0
     *  so the KV cache fits in VRAM alongside model weights. jdMaxChars is sized to this.
     *  Ollama-only - OpenRouter sizes its own context. */
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

  network: {
    /** Neutral and tiny (HTTP 204, empty body). The target is irrelevant beyond
     *  "something on the public internet that is essentially always up" — this
     *  answers "do we have a connection", not "is any particular board healthy". */
    probeUrl: process.env.NETWORK_PROBE_URL ?? "https://www.google.com/generate_204",
    probeTimeoutMs: envInt("NETWORK_PROBE_TIMEOUT_MS", 5_000),
    /** Healthy cadence. Cheap enough to leave running for a 14h sweep. */
    probeIntervalMs: envInt("NETWORK_PROBE_INTERVAL_MS", 10_000),
    /** During an outage — tighter, so the run resumes promptly once it is back. */
    probeDownIntervalMs: envInt("NETWORK_PROBE_DOWN_INTERVAL_MS", 5_000),
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
     *  (sheetRegistry.ts) or by read-only ops scripts. */
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
      // drive.file grants access ONLY to files this app creates - not your whole
      // Drive. Used to sync data/job_hunter.db between machines (see db/sync.ts).
      // Adding this scope requires re-running `npm run google-auth --profile <name>`.
      "https://www.googleapis.com/auth/drive.file",
    ],
    /** Filename the DB backup is stored under in Drive. drive.file scope means a
     *  name lookup only ever sees files this app itself created. */
    driveDbFileName: "job_hunter.db",
    /** Which profile's Google account owns the Drive backup. Profiles are separate
     *  accounts, so an unpinned second profile would create its OWN backup and pull
     *  it over the shared local DB. Empty = unpinned (single-profile setups); set
     *  DB_SYNC_PROFILE to the owning profile as soon as there is a second one. */
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

  outreach: {
    cooldownDays: 30,
    verifyAfterHours: 24,
    draftSeverities: ["green", "yellow"],
    templatePath: "config/outreach-template.md",
    attachResume: true,
  },
} as const;
