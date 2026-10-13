import { GATE_PROMPT } from "./llm/prompts/gate.js";
import { SHORTLIST_PROMPT, SHORTLIST_FROM_TEXT_PROMPT } from "./llm/prompts/shortlist.js";
import { EXTRACT_PROMPT } from "./llm/prompts/extract.js";
import { envInt, envList } from "./util/env.js";

// Typed `number`, not `as const`, so scheduler.ts's skip-if-disabled checks stay real.
const INTER_CALL_DELAY_MS: number = 250;
const DEFERRED_PASS_PACE_MS: number = 3_000;

/** Caps concurrency/spacing of a provider's board fetches; Workday's edge misreads bursts as failures. */
export interface ProviderThrottle {
  maxConcurrent: number;
  minSpacingMs: number;
}

// Typed for arbitrary-string lookup (no casts) so scheduler.ts can index by a live `company.provider`.
const PROVIDER_THROTTLE_TABLE: Partial<Record<string, ProviderThrottle>> = {
  workday: { maxConcurrent: 2, minSpacingMs: 4000 },
} as const;

export const config = {
  fetch: {
    concurrencyPerProvider: 4,
    workersPerCompany: 5,
    interCallDelayMs: INTER_CALL_DELAY_MS,
    timeoutMs: 60_000,
    transportRetries: 3,
    transportRetryBaseMs: 5_000,
    /** Some ATS edges throttle bursts, so the deferred pass runs boards one at a time, spaced. */
    deferredPassPaceMs: DEFERRED_PASS_PACE_MS,
    /** Some providers block the default node UA. */
    userAgent: "job-hunter-bot/0.1",
    /** Recruiters often fill the JD in after posting. */
    noJdRecheckDays: 7,
    providerThrottle: PROVIDER_THROTTLE_TABLE,
  },

  llm: {
    openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
    openRouterModel: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash-0731",
    /** No fallback beyond these: the prompt cache is per provider. Add a host only after temp/providerLoadTest.ts passes (digitalocean leaked other requests' JDs). */
    openRouterProviders: envList("OPENROUTER_PROVIDERS", ["together", "inceptron"]),
    openRouterUrl: "https://openrouter.ai/api/v1/chat/completions",
    /** Starts after the semaphore slot is acquired, so it measures generation, not queue wait. */
    timeoutMs: envInt("LLM_TIMEOUT_MS", 30_000),
    maxRetries: 2,
    gateErrorRetryMinutes: 60,
    maxConcurrent: envInt("LLM_MAX_CONCURRENT", 8),
    jdMaxChars: 18000,
  },

  prompts: {
    gate: GATE_PROMPT,
    shortlist: SHORTLIST_PROMPT,
    shortlistFromText: SHORTLIST_FROM_TEXT_PROMPT,
    extract: EXTRACT_PROMPT,
  },

  network: {
    probeUrl: process.env.NETWORK_PROBE_URL ?? "https://www.google.com/generate_204",
    probeTimeoutMs: envInt("NETWORK_PROBE_TIMEOUT_MS", 5_000),
    probeIntervalMs: envInt("NETWORK_PROBE_INTERVAL_MS", 10_000),
    probeDownIntervalMs: envInt("NETWORK_PROBE_DOWN_INTERVAL_MS", 5_000),
  },

  storage: {
    dbPath: process.env.JOB_HUNTER_DB_PATH ?? "data/job_hunter.db",
    registryPath: "data/registry-cache.json",
  },

  discord: {
    titlePrefix: "[job-hunter]",
    progressWebhookUrl: process.env.DISCORD_PROGRESS_WEBHOOK_URL,
    progressIntervalMs: 15 * 60 * 1000,
  },

  google: {
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID ?? "",
    tokenPathFor: (profileId: string) => `data/google-token-${profileId}.json`,
    scopes: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
    driveDbFileName: "job_hunter.db",
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

export function throttleFor(
  provider: string,
  table: Partial<Record<string, ProviderThrottle>> = config.fetch.providerThrottle,
): ProviderThrottle | undefined {
  return table[provider];
}
