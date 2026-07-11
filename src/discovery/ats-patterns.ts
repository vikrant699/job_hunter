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
  | "smartrecruiters" | "recruitee"
  | "ainterviews" | "freshteam" | "gohire" | "jobsoid" | "ceipal"
  | "ripplehire" | "zwayam" | "sensehq" | "breezyhr"
  | "turbohire" | "jazzhr" | "webbtree" | "zappyhire" | "talentrecruit" | "trakstar"
  | "sharechat" | "amazonjobs" | "wpjobs" | "mynexthire" | "metacareers"
  | "gem" | "dover" | "ycombinator" | "icicibank" | "reliance" | "magicpin" | "tatacareers"
  | "peoplehum" | "leapscholar" | "setu" | "radancy" | "atlassian" | "kula" | "urbancompany"
  // detect-only
  | "icims" | "successfactors" | "phenom" | "eightfold" | "eightfoldpcs"
  | "avature" | "workable" | "personio" | "teamtailor"
  | "jobvite" | "bamboohr" | "oracle" | "keka" | "darwinbox" | "greythr"
  | "zohorecruit" | "peoplestrong" | "jibe";

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
  recruitee:      { hasAdapter: true,  canValidate: true  },
  ainterviews:    { hasAdapter: true,  canValidate: true  },
  freshteam:      { hasAdapter: true,  canValidate: true  },
  gohire:         { hasAdapter: true,  canValidate: true  },
  jobsoid:        { hasAdapter: true,  canValidate: true  },
  ceipal:         { hasAdapter: true,  canValidate: false },
  ripplehire:     { hasAdapter: true,  canValidate: true  },
  zwayam:         { hasAdapter: true,  canValidate: false },
  sensehq:        { hasAdapter: true,  canValidate: true  },
  breezyhr:       { hasAdapter: true,  canValidate: true  },
  turbohire:      { hasAdapter: true,  canValidate: false },
  jazzhr:         { hasAdapter: true,  canValidate: true  },
  webbtree:       { hasAdapter: true,  canValidate: true  },
  zappyhire:      { hasAdapter: true,  canValidate: false },
  talentrecruit:  { hasAdapter: true,  canValidate: false },
  trakstar:       { hasAdapter: true,  canValidate: true  },
  sharechat:      { hasAdapter: true,  canValidate: false },
  amazonjobs:     { hasAdapter: true,  canValidate: false },
  wpjobs:         { hasAdapter: true,  canValidate: false },
  mynexthire:     { hasAdapter: true,  canValidate: true  },
  metacareers:    { hasAdapter: true,  canValidate: false },
  gem:            { hasAdapter: true,  canValidate: true  },
  dover:          { hasAdapter: true,  canValidate: true  },
  ycombinator:    { hasAdapter: true,  canValidate: true  },
  icicibank:      { hasAdapter: true,  canValidate: false },
  reliance:       { hasAdapter: true,  canValidate: false },
  magicpin:       { hasAdapter: true,  canValidate: false },
  tatacareers:    { hasAdapter: true,  canValidate: false },
  peoplehum:      { hasAdapter: true,  canValidate: false },
  leapscholar:    { hasAdapter: true,  canValidate: false },
  setu:           { hasAdapter: true,  canValidate: false },
  radancy:        { hasAdapter: true,  canValidate: false },
  atlassian:      { hasAdapter: true,  canValidate: false },
  kula:           { hasAdapter: true,  canValidate: true  },
  urbancompany:   { hasAdapter: true,  canValidate: false },
  jibe:           { hasAdapter: true,  canValidate: false },
  icims:          { hasAdapter: false, canValidate: false },
  successfactors: { hasAdapter: true,  canValidate: true  },
  phenom:         { hasAdapter: true,  canValidate: true  },
  eightfold:      { hasAdapter: true,  canValidate: false },
  eightfoldpcs:   { hasAdapter: true,  canValidate: false },
  avature:        { hasAdapter: true,  canValidate: true  },
  workable:       { hasAdapter: true,  canValidate: true  },
  personio:       { hasAdapter: false, canValidate: false },
  teamtailor:     { hasAdapter: false, canValidate: false },
  jobvite:        { hasAdapter: false, canValidate: false },
  bamboohr:       { hasAdapter: true,  canValidate: true  },
  oracle:         { hasAdapter: true,  canValidate: false },
  keka:           { hasAdapter: true,  canValidate: false },
  darwinbox:      { hasAdapter: true,  canValidate: true  },
  greythr:        { hasAdapter: true,  canValidate: true  },
  zohorecruit:    { hasAdapter: true,  canValidate: true  },
  peoplestrong:   { hasAdapter: true,  canValidate: true  },
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
    provider: "ainterviews",
    // ainterviews.com/job_board/<slug>/ or /api/job_board/<slug>/ — single shared host.
    re: /https?:\/\/(?:www\.)?ainterviews\.com\/(?:api\/)?job_board\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.pathname.match(/job_board\/([^/]+)/)?.[1];
      return slug ? { url: `https://ainterviews.com/job_board/${slug}/`, slug } : null;
    },
  },
  {
    provider: "freshteam",
    re: /https?:\/\/[a-z0-9-]+\.freshteam\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/jobs`, slug };
    },
  },
  {
    provider: "trakstar",
    re: /https?:\/\/[a-z0-9-]+\.hire\.trakstar\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/`, slug };
    },
  },
  {
    provider: "mynexthire",
    re: /https?:\/\/[a-z0-9-]+\.mynexthire\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/`, slug };
    },
  },
  {
    provider: "gem",
    // Public career boards at jobs.gem.com/<slug>, e.g. PromptQL, Fireflies, Bolna.
    re: /https?:\/\/jobs\.gem\.com\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://jobs.gem.com/${slug}`, slug } : null;
    },
  },
  {
    provider: "dover",
    // Shared host keyed by slug in the path: app.dover.com/jobs/<slug>.
    re: /https?:\/\/app\.dover\.com\/jobs\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.pathname.split("/").filter(Boolean)[1];
      return slug ? { url: `https://app.dover.com/jobs/${slug}`, slug } : null;
    },
  },
  {
    provider: "ycombinator",
    // YC startup job board; slug is the SECOND path segment (first is "companies").
    re: /https?:\/\/(?:www\.)?ycombinator\.com\/companies\/[a-z0-9-]+(?:\/jobs)?\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.pathname.split("/").filter(Boolean)[1];
      return slug ? { url: `https://www.ycombinator.com/companies/${slug}/jobs`, slug } : null;
    },
  },
  {
    provider: "gohire",
    re: /https?:\/\/jobs\.gohire\.io\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      return slug ? { url: `https://jobs.gohire.io/${slug}/`, slug } : null;
    },
  },
  {
    provider: "jobsoid",
    re: /https?:\/\/[a-z0-9-]+\.jobsoid\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/`, slug };
    },
  },
  {
    provider: "jazzhr",
    re: /https?:\/\/[a-z0-9-]+\.applytojob\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/apply`, slug };
    },
  },
  {
    provider: "webbtree",
    re: /https?:\/\/app\.webbtree\.com\/company\/[a-z0-9._-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.pathname.match(/\/company\/([^/]+)/)?.[1];
      return slug ? { url: `https://app.webbtree.com/company/${slug}/jobs`, slug } : null;
    },
  },
  {
    provider: "talentrecruit",
    re: /https?:\/\/[a-z0-9-]+\.talentrecruit\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      // app/appcareer/api are the vendor's shared hosts, not tenants.
      if (!slug || ["app", "appcareer", "api", "www"].includes(slug)) return null;
      return { url: `https://${u!.host}/career-page`, slug };
    },
  },
  // No turbohire URL pattern: custom accountName + orgId (careerpage UUID) needed,
  // browser-backed. No zappyhire pattern: backend host baked per-tenant in the JS
  // bundle. Both rely on registry seeding (canValidate:false).
  // No eightfoldpcs URL pattern: each tenant runs the PCSX API on its OWN
  // careers domain (careers.qualcomm.com, apply.careers.microsoft.com) with no
  // shared host signature — relies on registry seeding, like jibe/successfactors.
  // No ceipal URL pattern: its widget carries per-tenant api_key/cp_id in embed
  // attributes on the company's own site, with no shared per-tenant host/path.
  // No jibe URL pattern: iCIMS-CX on custom domains, no shared host signature.
  // No zwayam URL pattern: tenants on fully custom domains (careers.cyient.com)
  // + companyId needs bundle discovery, like keka (all rely on registry seeding /
  // careers-page HTML detection).
  {
    provider: "ripplehire",
    re: /https?:\/\/[a-z0-9-]+\.ripplehire\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      return slug ? { url: `https://${u!.host}`, slug } : null;
    },
  },
  {
    provider: "sensehq",
    re: /https?:\/\/[a-z0-9-]+\.sensehq\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}/careers`, slug };
    },
  },
  {
    provider: "breezyhr",
    re: /https?:\/\/[a-z0-9-]+\.breezy\.hr\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}`, slug };
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
    provider: "kula",
    re: /https?:\/\/careers\.kula\.ai\/[a-z0-9_-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      if (!slug || slug === "api") return null;
      return { url: `https://careers.kula.ai/${slug}`, slug };
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
  {
    provider: "peoplestrong",
    // <tenant>.peoplestrong.com Altone career portal. The subdomain is the slug.
    re: /https?:\/\/[a-z0-9-]+\.peoplestrong\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.host.split(".")[0];
      // www.peoplestrong.com is the vendor's marketing site, not a tenant.
      if (!slug || slug === "www") return null;
      return { url: `https://${u!.host}`, slug };
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
