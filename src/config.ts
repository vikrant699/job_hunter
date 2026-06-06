/**
 * Application config — runtime knobs that aren't user-specific.
 *
 * Personal stuff (your resume, deal-breakers, target locations, title-deny
 * patterns, services denylist) lives in `config/profile.ts` instead.
 */
import { GATE_PROMPT } from "./llm/prompts/gate.js";
import { SHORTLIST_PROMPT, SHORTLIST_FROM_TEXT_PROMPT } from "./llm/prompts/shortlist.js";
import { EXTRACT_PROMPT } from "./llm/prompts/extract.js";
import { SKIP_HOSTS, QUERY_POOL } from "./discovery/static-data.js";

export const config = {
  fetch: {
    /** How many companies of one provider run in parallel. */
    concurrencyPerProvider: 4,
    /** Postings processed in parallel inside one company. HTTP fans out;
     *  Ollama serializes via the semaphore in llm/client.ts. */
    workersPerCompany: 5,
    /** Politeness delay between worker-pool iterations within a company. */
    interCallDelayMs: 250,
    /** Per-call timeout for ATS fetches. */
    timeoutMs: 20_000,
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
    numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 9000),
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
    dbPath: "data/job_hunter.db",
    registryPath: "config/companies.json",
    postingRetentionDays: 90,
  },

  discord: {
    embedDescriptionMaxChars: 300,
    /** Prefix on every embed title — useful when sharing a channel with other bots. */
    titlePrefix: "[job-hunter]",
  },

  discovery: {
    /** Cap on new companies added per discovery run. Prevents a viral funding
     *  day or overly-broad query from flooding the registry. */
    maxAdditionsPerRun: 50,
    /** Don't add anything older than this. */
    rssMaxArticleAgeDays: 14,
    /** Hosts to skip — aggregators, content sites, salary-blog SEO farms. */
    skipHosts: [...SKIP_HOSTS],
    brave: {
      monthlyCap: 1000,
      monthlyBuffer: 50,
      queriesPerRun: 8,
      /** Rotating queries — daily run picks `queriesPerRun` by hash-of-date.
       *  Tune for your region and target role family. */
      queryPool: [...QUERY_POOL],
    },
    rss: {
      sources: [
        { name: "inc42-funding", url: "https://inc42.com/buzz/feed/" },
        { name: "yourstory-funding", url: "https://yourstory.com/category/funding/feed" },
      ],
    },
    yc: {
      directoryUrl: "https://www.ycombinator.com/companies?regions=India",
    },
  },
} as const;
