import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { getBraveQuotaUsed, incrementBraveQuota } from "../../db/index.js";

// Brave Search API. Quota tracked in the brave_quota table; halts when within
// `monthlyBuffer` of cap.
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const QUERY_TIMEOUT_MS = 15_000;

export interface BraveCandidate {
  name: string;
  careersUrl: string;
  source: "brave-search";
  evidence: string;
}

export interface BraveResult {
  candidates: BraveCandidate[];
  queriesRun: number;
  queriesAttempted: number;
  quotaUsedThisMonth: number;
  quotaCap: number;
  errors: string[];
  haltedReason: string | null;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      url: string;
      title?: string;
      description?: string;
    }>;
  };
}

// Deterministic by date — a re-run on the same day picks the same queries
// (no re-spend); day-over-day we rotate through the pool.
function pickQueriesForToday(pool: readonly string[], n: number): string[] {
  const today = new Date();
  // YYYYMMDD as a numeric seed
  const seed = today.getUTCFullYear() * 10000 + (today.getUTCMonth() + 1) * 100 + today.getUTCDate();
  const startIdx = seed % pool.length;
  const out: string[] = [];
  for (let i = 0; i < n && i < pool.length; i++) {
    out.push(pool[(startIdx + i) % pool.length]!);
  }
  return out;
}

function extractCompanyName(title: string | undefined, url: string): string | null {
  const t = (title ?? "").trim();
  if (t) {
    let cleaned = t
      .replace(/\s*[-–—|·]\s*(careers?|jobs?|hiring|join us|work with us).*$/i, "")
      .replace(/^(careers?|jobs?)\s+at\s+/i, "")
      .replace(/\s+(careers?|jobs?|hiring)\s*$/i, "")
      .trim();
    // Drop nonsense fragments
    if (cleaned.length >= 2 && cleaned.length <= 80 && !/^https?:/i.test(cleaned)) {
      return cleaned;
    }
  }
  // Fallback: derive from URL host
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    const apex = host.split(".")[0];
    if (apex && apex.length >= 2) {
      return apex.charAt(0).toUpperCase() + apex.slice(1);
    }
  } catch { /* fall through */ }
  return null;
}

export function shouldSkipHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^www\./, "");
  for (const skip of config.discovery.skipHosts) {
    if (lower === skip || lower.endsWith(`.${skip}`)) return true;
  }
  return false;
}

// "Careers-shaped" URL detection — path or host suggests a real careers
// listing, not a blog post or salary article. High-precision (false negatives
// are cheaper than false positives flooding the registry).
export function isCareerShaped(url: URL): boolean {
  const host = url.host.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();

  // Always reject obvious blog subdomains even if path looks careers-y —
  // "/blog/index.php/careers/" is just a blog post about careers.
  if (host.startsWith("blog.")) return false;
  if (host.startsWith("news.")) return false;

  // Known ATS hosts — automatically pass
  if (/(boards|jobs|job-boards|careers)\.greenhouse\.io$/.test(host)) return true;
  if (host === "jobs.lever.co") return true;
  if (host === "jobs.ashbyhq.com") return true;
  if (host.endsWith(".myworkdayjobs.com")) return true;
  if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") return true;
  if (host.endsWith(".eightfold.ai") && host !== "app.eightfold.ai" && host !== "static.eightfold.ai") return true;
  if (host.endsWith(".recruitee.com")) return true;
  if (host.endsWith(".icims.com")) return true;
  if (host.endsWith(".phenompeople.com") && host !== "cdn.phenompeople.com") return true;

  // Custom careers subdomain
  if (/^(careers|jobs|career|hiring|work|join)\./.test(host)) return true;

  // Path indicates a careers area — but reject blog/salary/article paths
  if (/\/(careers?|jobs?|positions?|openings?|opportunit|hiring|roles?|vacanc)(\/|$)/.test(path)) {
    // Reject if path also contains blog/salary/news/article markers
    if (/\/(blog|salary|salaries|article|news|guide|tutorial|course|learn|how-to|2024|2025|2026)\b/.test(path)) return false;
    return true;
  }
  return false;
}

// Filters out aggregator / VC-portfolio pages that mention the company name
// but aren't on the company's own domain. Tokens <4 chars are skipped to
// avoid acronym false positives.
export function hostMatchesName(host: string, name: string): boolean {
  const hostLower = host.toLowerCase().replace(/^www\./, "");
  const tokens = name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  // For very short names like "MPL" / "ABB", fall back to a 3-char prefix check
  if (tokens.length === 0) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return compact.length >= 3 && hostLower.includes(compact);
  }
  return tokens.some((t) => hostLower.includes(t));
}

// Shared with URL-repair so both call sites consume from one quota budget.
export interface BraveSearchResult {
  url: string;
  title?: string;
  description?: string;
}

export async function searchBrave(query: string, opts: { count?: number; country?: string } = {}): Promise<BraveSearchResult[] | null> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey || apiKey.length < 10) return null;

  const cap = config.discovery.brave.monthlyCap - config.discovery.brave.monthlyBuffer;
  const usedBefore = getBraveQuotaUsed();
  if (usedBefore >= cap) {
    logger.debug({ usedBefore, cap }, "brave: quota exhausted, search skipped");
    return null;
  }

  try {
    const resp = await runOneQuery(query, apiKey, opts.count ?? 10, opts.country ?? "in");
    incrementBraveQuota(1);
    return resp.web?.results ?? [];
  } catch (err) {
    logger.warn({ query, err: String(err).slice(0, 120) }, "brave: search failed");
    return null;
  }
}

async function runOneQuery(query: string, apiKey: string, count = 15, country = "in"): Promise<BraveSearchResponse> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}&country=${country}&search_lang=en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": config.fetch.userAgent,
      },
      signal: controller.signal,
    });
    if (res.status === 429) {
      throw new Error("Brave 429: rate-limited (quota likely exhausted)");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Brave ${res.status}: auth failed (check BRAVE_API_KEY)`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brave HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as BraveSearchResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function runBraveSource(): Promise<BraveResult> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    return {
      candidates: [], queriesRun: 0, queriesAttempted: 0,
      quotaUsedThisMonth: 0, quotaCap: config.discovery.brave.monthlyCap,
      errors: ["BRAVE_API_KEY not set in env"],
      haltedReason: "no-api-key",
    };
  }

  const cap = config.discovery.brave.monthlyCap - config.discovery.brave.monthlyBuffer;
  const usedBefore = getBraveQuotaUsed();
  const remaining = Math.max(0, cap - usedBefore);

  if (remaining === 0) {
    return {
      candidates: [], queriesRun: 0, queriesAttempted: 0,
      quotaUsedThisMonth: usedBefore, quotaCap: config.discovery.brave.monthlyCap,
      errors: [],
      haltedReason: "monthly-quota-exhausted",
    };
  }

  const planned = pickQueriesForToday(
    config.discovery.brave.queryPool,
    Math.min(config.discovery.brave.queriesPerRun, remaining)
  );

  const candidates: BraveCandidate[] = [];
  const errors: string[] = [];
  let queriesRun = 0;
  let halted: string | null = null;

  for (const query of planned) {
    try {
      const resp = await runOneQuery(query, apiKey);
      incrementBraveQuota(1);
      queriesRun++;

      for (const r of resp.web?.results ?? []) {
        if (!r.url) continue;
        let parsed: URL;
        try { parsed = new URL(r.url); } catch { continue; }
        if (shouldSkipHost(parsed.host)) continue;
        if (!isCareerShaped(parsed)) continue;  // reject blog posts / salary articles

        const name = extractCompanyName(r.title, r.url);
        if (!name) continue;

        candidates.push({
          name,
          // Save the result URL as careers_url — it matched our `inurl:careers`
          // / similar pattern, so it's a careers page (or very close to one).
          careersUrl: r.url,
          source: "brave-search",
          evidence: `Brave: "${query}" → ${r.title?.slice(0, 80) ?? "(no title)"}`,
        });
      }
    } catch (err) {
      const msg = String(err).slice(0, 180);
      errors.push(`${query}: ${msg}`);
      logger.warn({ query, err: msg }, "brave: query failed");
      // Stop early on quota / auth — don't burn the remaining budget on more 429s.
      if (msg.includes("Brave 429") || msg.includes("Brave 401") || msg.includes("Brave 403")) {
        halted = msg.includes("429") ? "rate-limited-during-run" : "auth-failed";
        break;
      }
    }
  }

  return {
    candidates,
    queriesRun,
    queriesAttempted: planned.length,
    quotaUsedThisMonth: usedBefore + queriesRun,
    quotaCap: config.discovery.brave.monthlyCap,
    errors,
    haltedReason: halted,
  };
}
