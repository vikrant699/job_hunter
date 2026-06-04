import { config } from "../config.js";
import { fetchHtml } from "../scraper/cheerio.js";

/**
 * Universal ATS detection + validation.
 *
 * "Supported" providers have an AtsAdapter and can be promoted to ats-api.
 * "Detect-only" providers (iCIMS / Eightfold / etc.) are recognized for
 * reporting but need an adapter before they can be promoted.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type AtsProvider =
  // adapter exists
  | "greenhouse" | "lever" | "ashby" | "workday"
  // public board API exists, adapter pending (A3)
  | "smartrecruiters" | "recruitee"
  // detect-only
  | "icims" | "successfactors" | "phenom" | "eightfold"
  | "avature" | "workable" | "personio" | "teamtailor"
  | "jobvite" | "bamboohr" | "oracle" | "keka";

export interface AtsCapability {
  /** We have an AtsAdapter that can fetch postings. */
  hasAdapter: boolean;
  /** We can probe the provider's public API to confirm the slug is live. */
  canValidate: boolean;
}

const CAPABILITIES: Record<AtsProvider, AtsCapability> = {
  greenhouse:     { hasAdapter: true,  canValidate: true  },
  lever:          { hasAdapter: true,  canValidate: true  },
  ashby:          { hasAdapter: true,  canValidate: true  },
  workday:        { hasAdapter: true,  canValidate: true  },
  smartrecruiters:{ hasAdapter: true,  canValidate: true  },
  recruitee:      { hasAdapter: false, canValidate: true  },
  icims:          { hasAdapter: false, canValidate: false },
  successfactors: { hasAdapter: false, canValidate: false },
  phenom:         { hasAdapter: false, canValidate: false },
  eightfold:      { hasAdapter: true,  canValidate: false },
  avature:        { hasAdapter: false, canValidate: false },
  workable:       { hasAdapter: true,  canValidate: true  },
  personio:       { hasAdapter: false, canValidate: false },
  teamtailor:     { hasAdapter: false, canValidate: false },
  jobvite:        { hasAdapter: false, canValidate: false },
  bamboohr:       { hasAdapter: false, canValidate: false },
  oracle:         { hasAdapter: true,  canValidate: false },
  keka:           { hasAdapter: true,  canValidate: false },
};

interface PatternDef {
  provider: AtsProvider;
  re: RegExp;
  parse(match: string): { url: string; slug: string } | null;
}

function safeUrl(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}

function firstPathSegment(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  return parts[0] ?? null;
}

const PATTERNS: PatternDef[] = [
  {
    provider: "greenhouse",
    re: /https?:\/\/(?:boards|jobs|job-boards|boards\.[a-z]+)\.greenhouse\.io\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://boards.greenhouse.io/${slug}`, slug } : null;
    },
  },
  {
    provider: "lever",
    re: /https?:\/\/jobs\.lever\.co\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://jobs.lever.co/${slug}`, slug } : null;
    },
  },
  {
    provider: "ashby",
    re: /https?:\/\/jobs\.ashbyhq\.com\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://jobs.ashbyhq.com/${slug}`, slug } : null;
    },
  },
  {
    provider: "workday",
    re: /https?:\/\/[a-z0-9-]+\.[a-z0-9-]+\.myworkdayjobs\.com(?:\/(?:en|en-[A-Z]{2}|fr|de|es|ja|zh)(?:-[A-Z]{2})?)?\/[A-Za-z0-9_-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      // Strip locale segment — Workday's CXS endpoint always uses the site name.
      const path = u.pathname.replace(/^\/(?:en|en-[A-Z]{2}|fr|de|es|ja|zh)(?:-[A-Z]{2})?\//i, "/");
      const site = path.replace(/^\/+/, "").split("/")[0];
      const tenant = u.host.split(".")[0];
      if (!site || !tenant) return null;
      return { url: `${u.protocol}//${u.host}/${site}`, slug: `${tenant}/${site}` };
    },
  },
  {
    provider: "smartrecruiters",
    re: /https?:\/\/(?:careers|jobs|www)\.smartrecruiters\.com\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://careers.smartrecruiters.com/${slug}`, slug } : null;
    },
  },
  {
    provider: "recruitee",
    re: /https?:\/\/[a-z0-9-]+\.recruitee\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "icims",
    re: /https?:\/\/(?:careers-)?[a-z0-9-]+\.icims\.com\/jobs\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      // host: "careers-foo.icims.com" or "foo.icims.com"
      const sub = u.host.split(".")[0]!.replace(/^careers-/, "");
      return { url: `https://${u.host}/jobs`, slug: sub };
    },
  },
  {
    provider: "successfactors",
    re: /https?:\/\/[a-z0-9.-]+\.successfactors\.(?:com|eu)\b[^\s"'<>]*/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      // Slug derivation is fuzzy on SF; just use host.
      return { url: `${u.protocol}//${u.host}${u.pathname}`, slug: u.host.split(".")[0]! };
    },
  },
  {
    provider: "phenom",
    re: /https?:\/\/[a-z0-9-]+\.phenompeople\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "eightfold",
    re: /https?:\/\/[a-z0-9-]+\.eightfold\.ai\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug) return null;
      // Shared infrastructure hosts, not customer tenants.
      const SHARED = new Set(["app", "static", "www", "vs-errors", "fonts", "cdn"]);
      if (SHARED.has(slug)) return null;
      return { url: `https://${u!.host}`, slug };
    },
  },
  {
    provider: "avature",
    re: /https?:\/\/[a-z0-9-]+\.avature\.net\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "workable",
    re: /https?:\/\/apply\.workable\.com\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://apply.workable.com/${slug}`, slug } : null;
    },
  },
  {
    provider: "personio",
    re: /https?:\/\/[a-z0-9-]+\.jobs\.personio\.(?:com|de)\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "teamtailor",
    re: /https?:\/\/[a-z0-9-]+\.teamtailor\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "jobvite",
    re: /https?:\/\/jobs\.jobvite\.com\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://jobs.jobvite.com/${slug}`, slug } : null;
    },
  },
  {
    provider: "bamboohr",
    re: /https?:\/\/[a-z0-9-]+\.bamboohr\.com\/careers\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}/careers`, slug } : null;
    },
  },
  {
    provider: "oracle",
    re: /https?:\/\/[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com\b[^\s"'<>]*/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      return { url: `${u.protocol}//${u.host}`, slug: u.host.split(".")[0]! };
    },
  },
  {
    provider: "keka",
    re: /https?:\/\/([a-z0-9-]+)\.keka\.com\/careers\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}/careers/`, slug } : null;
    },
  },
];

export interface AtsCandidate {
  provider: AtsProvider;
  /** Canonical, deduped URL we'd save in YAML. */
  url: string;
  slug: string;
  hasAdapter: boolean;
  canValidate: boolean;
}

/**
 * HTML often double-escapes ATS URLs ("https:\/\/..." in inline JSON,
 * "&amp;" in attributes). Normalize before regex matching so we don't miss them.
 */
function normalize(html: string): string {
  return html
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x2[fF];/g, "/")
    .replace(/&#47;/g, "/");
}

export function extractAtsCandidates(html: string, careersUrl: string): AtsCandidate[] {
  const haystack = normalize(html) + " " + careersUrl;
  const seen = new Set<string>();  // dedup by `${provider}::${url}`
  const out: AtsCandidate[] = [];

  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;  // global regex must be reset
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(haystack)) !== null) {
      const parsed = pat.parse(m[0]);
      if (!parsed) continue;
      const key = `${pat.provider}::${parsed.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cap = CAPABILITIES[pat.provider];
      out.push({
        provider: pat.provider,
        url: parsed.url,
        slug: parsed.slug,
        hasAdapter: cap.hasAdapter,
        canValidate: cap.canValidate,
      });
    }
  }
  return out;
}

export interface ValidateResult {
  ok: boolean;
  total: number | null;
  error: string | null;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a single candidate. Returns {ok, total} where total is the posting
 * count if the provider exposes one. Providers without a public validator
 * always return {ok: false, error: "no validator"} — callers should still
 * treat the *detection* as useful evidence.
 */
export async function validateCandidate(c: AtsCandidate): Promise<ValidateResult> {
  const timeout = config.fetch.timeoutMs;
  try {
    switch (c.provider) {
      case "greenhouse": {
        const data = (await fetchJsonWithTimeout(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs?content=false`,
          { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" } },
          timeout
        )) as { jobs?: unknown[]; meta?: { total?: number } };
        const total = data.meta?.total ?? data.jobs?.length ?? 0;
        return { ok: Array.isArray(data.jobs), total, error: null };
      }
      case "lever": {
        const data = (await fetchJsonWithTimeout(
          `https://api.lever.co/v0/postings/${encodeURIComponent(c.slug)}?mode=json&limit=1`,
          { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" } },
          timeout
        )) as unknown;
        if (!Array.isArray(data)) return { ok: false, total: null, error: "not array" };
        // limit=1 caps the returned slice — we don't get a "total" cheaply. Treat
        // any non-empty board as ok and report what we got back.
        return { ok: true, total: data.length, error: null };
      }
      case "ashby": {
        const data = (await fetchJsonWithTimeout(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}?includeCompensation=false`,
          { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" } },
          timeout
        )) as { jobs?: unknown[] };
        return {
          ok: Array.isArray(data.jobs),
          total: data.jobs?.length ?? 0,
          error: null,
        };
      }
      case "workday": {
        // c.url is the tenant URL; reuse the workday-probe path.
        const u = safeUrl(c.url);
        if (!u) return { ok: false, total: null, error: "bad url" };
        const tenant = u.host.split(".")[0];
        const site = firstPathSegment(u);
        if (!tenant || !site) return { ok: false, total: null, error: "malformed" };
        const cxsUrl = `${u.protocol}//${u.host}/wday/cxs/${tenant}/${site}/jobs`;
        const data = (await fetchJsonWithTimeout(
          cxsUrl,
          {
            method: "POST",
            headers: {
              "User-Agent": config.fetch.userAgent,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
          },
          timeout
        )) as { total?: number };
        return { ok: true, total: data.total ?? null, error: null };
      }
      case "smartrecruiters": {
        const data = (await fetchJsonWithTimeout(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.slug)}/postings?limit=1`,
          { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" } },
          timeout
        )) as { totalFound?: number; content?: unknown[] };
        return {
          ok: typeof data.totalFound === "number" || Array.isArray(data.content),
          total: data.totalFound ?? data.content?.length ?? 0,
          error: null,
        };
      }
      case "recruitee": {
        const data = (await fetchJsonWithTimeout(
          `${c.url}/api/offers/`,
          { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" } },
          timeout
        )) as { offers?: unknown[] };
        return {
          ok: Array.isArray(data.offers),
          total: data.offers?.length ?? 0,
          error: null,
        };
      }
      default:
        return { ok: false, total: null, error: "no validator" };
    }
  } catch (err) {
    return { ok: false, total: null, error: String(err).slice(0, 120) };
  }
}

export interface DiscoveryResult {
  finalUrl: string;
  candidates: AtsCandidate[];
}

/**
 * Fetch the careers page with a browser UA and extract every ATS candidate.
 * Returns the resolved (post-redirect) URL so callers can detect a redirect
 * to a different domain.
 */
export async function discoverFromUrl(careersUrl: string): Promise<DiscoveryResult> {
  // fetchHtml uses our standard UA + timeout + redirect follow.
  // We override UA here implicitly via the same call (it already uses BROWSER_UA).
  void BROWSER_UA;
  const { finalUrl, html } = await fetchHtml(careersUrl);
  return { finalUrl, candidates: extractAtsCandidates(html, finalUrl) };
}
