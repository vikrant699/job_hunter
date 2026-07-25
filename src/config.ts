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

export const config = {
  fetch: {
    /** How many companies of one provider run in parallel. */
    concurrencyPerProvider: 4,
    /** Postings processed in parallel inside one company. HTTP fans out;
     *  Ollama serializes via the semaphore in llm/client.ts. */
    workersPerCompany: 5,
    /** Politeness delay between worker-pool iterations within a company. */
    interCallDelayMs: 250,
    /** Per-call timeout for ATS fetches. Raised 20s -> 60s (2026-07-23): big
     *  paginated boards (Bosch ~24s, ABB ~30s) were being aborted mid-fetch under
     *  load, dropping their entire posting set. See config-repair memory. */
    timeoutMs: 60_000,
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
