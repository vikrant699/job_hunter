import { fetchHtml } from "../scraper/cheerio.js";

/**
 * Universal ATS detection + pattern extraction.
 *
 * "Supported" providers have an AtsAdapter and can be promoted to ats-api.
 * "Detect-only" providers (iCIMS / Eightfold / etc.) are recognized for
 * reporting but need an adapter before they can be promoted.
 */

export type AtsProvider =
  // adapter exists
  | "greenhouse" | "lever" | "ashby" | "workday"
  // public board API exists, adapter pending (A3)
  | "smartrecruiters" | "recruitee"
  // detect-only
  | "icims" | "successfactors" | "phenom" | "eightfold"
  | "avature" | "workable" | "personio" | "teamtailor"
  | "jobvite" | "bamboohr" | "oracle" | "keka" | "darwinbox" | "greythr"
  | "zohorecruit";

export interface AtsCapability {
  /** We have an AtsAdapter that can fetch postings. */
  hasAdapter: boolean;
  /** We can probe the provider's public API to confirm the slug is live. */
  canValidate: boolean;
}

export const CAPABILITIES: Record<AtsProvider, AtsCapability> = {
  greenhouse:     { hasAdapter: true,  canValidate: true  },
  lever:          { hasAdapter: true,  canValidate: true  },
  ashby:          { hasAdapter: true,  canValidate: true  },
  workday:        { hasAdapter: true,  canValidate: true  },
  smartrecruiters:{ hasAdapter: true,  canValidate: true  },
  recruitee:      { hasAdapter: false, canValidate: true  },
  icims:          { hasAdapter: false, canValidate: false },
  successfactors: { hasAdapter: true,  canValidate: true  },
  phenom:         { hasAdapter: true,  canValidate: true  },
  eightfold:      { hasAdapter: true,  canValidate: false },
  avature:        { hasAdapter: false, canValidate: false },
  workable:       { hasAdapter: true,  canValidate: true  },
  personio:       { hasAdapter: false, canValidate: false },
  teamtailor:     { hasAdapter: false, canValidate: false },
  jobvite:        { hasAdapter: false, canValidate: false },
  bamboohr:       { hasAdapter: false, canValidate: false },
  oracle:         { hasAdapter: true,  canValidate: false },
  keka:           { hasAdapter: true,  canValidate: false },
  darwinbox:      { hasAdapter: true,  canValidate: true  },
  greythr:        { hasAdapter: true,  canValidate: true  },
  zohorecruit:    { hasAdapter: true,  canValidate: true  },
} as const;

interface PatternDef {
  provider: AtsProvider;
  re: RegExp;
  parse(match: string): { url: string; slug: string } | null;
}

export function safeUrl(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}

export function firstPathSegment(u: URL): string | null {
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
  // No successfactors URL pattern: the adapter (src/ats/successfactors.ts)
  // targets the LEGACY Jobs2Web engine on each company's CUSTOM domain (e.g.
  // jobs.heromotocorp.com), which shares no host signature. The only shared-host
  // successfactors.com URLs belong to the GATED SAPUI5 app the adapter can't
  // scrape, so matching them would only mis-promote them to ats-api. Discovery
  // relies on registry seeding / careers-page HTML detection, like jibe.
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
  {
    provider: "darwinbox",
    re: /https?:\/\/[a-z0-9-]+\.darwinbox\.(?:in|com)\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "greythr",
    // <tenant>.greythr.com/hire/... public recruitment board.
    re: /https?:\/\/[a-z0-9-]+\.greythr\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      // www.greythr.com is the vendor's own marketing/careers site, not a tenant.
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/hire/jobs/`, slug };
    },
  },
  {
    provider: "zohorecruit",
    // <tenant>.zohorecruit.com|.in hosted career site. The segment after
    // /jobs/ is the tenant's career-site page name — usually "Careers" but
    // tenant-chosen (e.g. "Job-openings") — so preserve it when present.
    re: /https?:\/\/[a-z0-9-]+\.zohorecruit\.(?:com|in)\b[^\s"'<>]*/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      // www.zohorecruit.com is the vendor's marketing site, not a tenant.
      if (!slug || slug === "www") return null;
      const page = u!.pathname.match(/^\/jobs\/([^/]+)/)?.[1] ?? "Careers";
      return { url: `https://${u!.host}/jobs/${page}`, slug };
    },
  },
] as const;

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

export interface AtsFetchResult {
  finalUrl: string;
  candidates: AtsCandidate[];
}

/**
 * Fetch the careers page with a browser UA and extract every ATS candidate.
 * Returns the resolved (post-redirect) URL so callers can detect a redirect
 * to a different domain.
 */
export async function discoverFromUrl(careersUrl: string): Promise<AtsFetchResult> {
  // fetchHtml uses our standard UA + timeout + redirect follow.
  const { finalUrl, html } = await fetchHtml(careersUrl);
  return { finalUrl, candidates: extractAtsCandidates(html, finalUrl) };
}
