import { ProviderSchema } from "../schemas.js";
import type { Provider } from "../schemas.js";

/**
 * Universal ATS detection + pattern extraction.
 *
 * "Supported" providers have an AtsAdapter and can be promoted to ats-api.
 * "Detect-only" providers (iCIMS / Eightfold / etc.) are recognized for
 * reporting but need an adapter before they can be promoted.
 */

/** Providers the detector can recognize in page HTML. A recognized provider
 *  "hasAdapter" exactly when it is a ProviderSchema enum value - detect-only
 *  vendors (personio, successfactors-ui5) are recognized for logging but cannot
 *  be promoted to ats-api. */
export type DetectableProvider =
  | Provider
  | "icims" | "personio" | "jobvite" | "consider" | "talentzq" | "successfactors-ui5";

interface PatternDef {
  provider: DetectableProvider;
  re: RegExp;
  // careersUrl is passed through so a pattern can fall back to the careers
  // page's own host when its match carries no host of its own (see
  // "consider" below); most patterns ignore the second argument.
  parse(match: string, careersUrl: string): { url: string; slug: string } | null;
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
    },
  },
  {
    provider: "pinpoint",
    re: /https?:\/\/[a-z0-9-]+\.pinpointhq\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/jobs`, slug };
    },
  },
  {
    provider: "trakstar",
    re: /https?:\/\/[a-z0-9-]+\.hire\.trakstar\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/`, slug };
    },
  },
  {
    provider: "mynexthire",
    re: /https?:\/\/[a-z0-9-]+\.mynexthire\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/`, slug };
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/`, slug };
    },
  },
  {
    provider: "jobvite",
    re: /https?:\/\/jobs\.jobvite\.com\/[a-z0-9-]+\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.pathname.split("/").find((s) => s !== "");
      if (slug === undefined || slug === "search" || slug === "job" || slug === "api") return null;
      return { url: `https://jobs.jobvite.com/${slug}`, slug };
    },
  },
  {
    provider: "jazzhr",
    re: /https?:\/\/[a-z0-9-]+\.applytojob\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/apply`, slug };
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      // app/appcareer/api are the vendor's shared hosts, not tenants.
      if (!slug || ["app", "appcareer", "api", "www"].includes(slug)) return null;
      return { url: `https://${u.host}/career-page`, slug };
    },
  },
  // No turbohire URL pattern: custom accountName + orgId (careerpage UUID) needed,
  // browser-backed. No zappyhire pattern: backend host baked per-tenant in the JS
  // bundle. Both rely on registry seeding.
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
    },
  },
  {
    provider: "sensehq",
    re: /https?:\/\/[a-z0-9-]+\.sensehq\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/careers`, slug };
    },
  },
  {
    provider: "breezyhr",
    re: /https?:\/\/[a-z0-9-]+\.breezy\.hr\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}`, slug };
    },
  },
  {
    provider: "icims",
    re: /https?:\/\/(?:careers-)?[a-z0-9-]+\.icims\.com\/jobs\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      // host: "careers-foo.icims.com" or "foo.icims.com"
      const first = u.host.split(".")[0];
      if (!first) return null;
      return { url: `https://${u.host}/jobs`, slug: first.replace(/^careers-/, "") };
    },
  },
  {
    // Deliberately NOT "successfactors" — that name is a ProviderSchema member,
    // which would make hasAdapter compute to true and falsely advertise an
    // adapter for this shape. career<N>.successfactors.(com|eu)/career?company=
    // <slug> is the shared-host SAPUI5 portal (e.g.
    // career10.successfactors.com/career?company=bioconlimi for Biocon) —
    // a DIFFERENT engine from the one src/ats/successfactors.ts talks to. That
    // adapter only handles the LEGACY Jobs2Web engine on each tenant's own
    // CUSTOM domain (e.g. jobs.heromotocorp.com via GET <origin>/search/?q=...),
    // which shares no host signature across tenants and so has no pattern here
    // — it's found via registry seeding instead, like jibe. This SAPUI5 shape
    // was previously unmatched entirely (boards on it silently stayed on
    // llm-scrape); it's detect-only ("successfactors-ui5", hasAdapter:false)
    // until an adapter for it exists.
    provider: "successfactors-ui5",
    re: /https?:\/\/career\d*\.successfactors\.(?:com|eu)\/career\?company=([A-Za-z0-9_-]+)/gi,
    parse(m) {
      const slug = /company=([A-Za-z0-9_-]+)/i.exec(m)?.[1];
      return slug ? { url: m, slug } : null;
    },
  },
  {
    provider: "consider",
    // Consider.co's "search jobs" widget (seen on VC portfolio career pages,
    // e.g. careers.peakxv.com) calls fetch("/api-boards/search-jobs") — usually
    // a same-origin RELATIVE path on the customer's own domain rather than an
    // absolute consider.co URL. Fall back to the careers page's own host when
    // the match carries none of its own. No adapter yet (see
    // DetectableProvider) — hasAdapter is false until one is built.
    re: /(?:https?:\/\/[a-z0-9.-]+)?\/api-boards\/search-jobs\b/gi,
    parse(m, careersUrl) {
      const abs = /^https?:\/\/([a-z0-9.-]+)\//i.exec(m)?.[1];
      const host = abs ?? safeUrl(careersUrl)?.host;
      if (!host) return null;
      const slug = host.split(".")[0];
      return slug ? { url: `https://${host}/api-boards/search-jobs`, slug } : null;
    },
  },
  {
    provider: "talentzq",
    // <tenant>.talentzq.io shared host (e.g. pratilipi.talentzq.io/api/1009/jd).
    // No adapter yet — hasAdapter is false until one is built.
    re: /https?:\/\/([a-z0-9-]+)\.talentzq\.io\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}`, slug };
    },
  },
  {
    provider: "phenom",
    re: /https?:\/\/[a-z0-9-]+\.phenompeople\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
    },
  },
  {
    provider: "eightfold",
    re: /https?:\/\/[a-z0-9-]+\.eightfold\.ai\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug) return null;
      // Shared infrastructure hosts, not customer tenants.
      const SHARED = new Set(["app", "static", "www", "vs-errors", "fonts", "cdn"]);
      if (SHARED.has(slug)) return null;
      return { url: `https://${u.host}`, slug };
    },
  },
  {
    provider: "avature",
    re: /https?:\/\/[a-z0-9-]+\.avature\.net\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
    },
  },
  {
    provider: "teamtailor",
    re: /https?:\/\/[a-z0-9-]+\.teamtailor\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}/careers`, slug } : null;
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
    provider: "goodfit",
    re: /https?:\/\/app\.goodfit\.so\/jobs\/[a-z0-9_-]+/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u?.pathname.split("/").filter(Boolean)[1];
      return slug ? { url: `https://app.goodfit.so/jobs/${slug}`, slug } : null;
    },
  },
  {
    provider: "superworks",
    re: /https?:\/\/[a-z0-9-]+\.superworks\.com\/job\/listing/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug || slug === "www" || slug === "jobs") return null;
      return { url: `https://${u.host}/job/listing`, slug };
    },
  },
  {
    provider: "recruiterflow",
    re: /https?:\/\/recruiterflow\.com\/[a-z0-9_-]+\/jobs\b/gi,
    parse(m) {
      const u = safeUrl(m);
      const slug = u ? firstPathSegment(u) : null;
      if (!slug || slug === "api" || slug === "static") return null;
      return { url: `https://recruiterflow.com/${slug}/jobs`, slug };
    },
  },
  {
    provider: "oracle",
    re: /https?:\/\/[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com\b[^\s"'<>]*/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      if (!slug) return null;
      return { url: `${u.protocol}//${u.host}`, slug };
    },
  },
  {
    provider: "keka",
    re: /https?:\/\/([a-z0-9-]+)\.keka\.com\/careers\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}/careers/`, slug } : null;
    },
  },
  {
    provider: "darwinbox",
    re: /https?:\/\/[a-z0-9-]+\.darwinbox\.(?:in|com)\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      return slug ? { url: `https://${u.host}`, slug } : null;
    },
  },
  {
    provider: "greythr",
    // <tenant>.greythr.com/hire/... public recruitment board.
    re: /https?:\/\/[a-z0-9-]+\.greythr\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      // www.greythr.com is the vendor's own marketing/careers site, not a tenant.
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}/hire/jobs/`, slug };
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
      if (!u) return null;
      const slug = u.host.split(".")[0];
      // www.zohorecruit.com is the vendor's marketing site, not a tenant.
      if (!slug || slug === "www") return null;
      const page = u.pathname.match(/^\/jobs\/([^/]+)/)?.[1] ?? "Careers";
      return { url: `https://${u.host}/jobs/${page}`, slug };
    },
  },
  {
    provider: "peoplestrong",
    // <tenant>.peoplestrong.com Altone career portal. The subdomain is the slug.
    re: /https?:\/\/[a-z0-9-]+\.peoplestrong\.com\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const slug = u.host.split(".")[0];
      // www.peoplestrong.com is the vendor's marketing site, not a tenant.
      if (!slug || slug === "www") return null;
      return { url: `https://${u.host}`, slug };
    },
  },
  {
    provider: "skima",
    // Tenants sit on custom domains whose pages carry a canonical/asset link
    // to "<custom-domain>.skima.ai" (e.g. careers.nykaa.com.skima.ai). The
    // tenant board is the custom domain itself — strip the vendor suffix.
    re: /https?:\/\/[a-z0-9.-]+\.skima\.ai\b/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const host = u.host.replace(/\.skima\.ai$/i, "");
      // Vendor's own hosts (www.skima.ai, api.skima.ai) have no dots left.
      if (!host.includes(".")) return null;
      return { url: `https://${host}/`, slug: host };
    },
  },
] as const;

export interface AtsCandidate {
  provider: DetectableProvider;
  /** Canonical, deduped URL we'd save in YAML. */
  url: string;
  slug: string;
  hasAdapter: boolean;
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

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(ProviderSchema.options);

export function extractAtsCandidates(html: string, careersUrl: string): AtsCandidate[] {
  const haystack = normalize(html) + " " + careersUrl;
  const seen = new Set<string>();  // dedup by `${provider}::${url}`
  const out: AtsCandidate[] = [];

  for (const pat of PATTERNS) {
    pat.re.lastIndex = 0;  // global regex must be reset
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(haystack)) !== null) {
      const parsed = pat.parse(m[0], careersUrl);
      if (!parsed) continue;
      const key = `${pat.provider}::${parsed.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        provider: pat.provider,
        url: parsed.url,
        slug: parsed.slug,
        hasAdapter: KNOWN_PROVIDERS.has(pat.provider),
      });
    }
  }
  return out;
}
