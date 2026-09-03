import { ProviderSchema } from "../schemas.js";
import type { Provider } from "../schemas.js";

// Universal ATS detection + pattern extraction. "Supported" providers have an AtsAdapter and can be promoted to
// ats-api; "detect-only" providers are recognized for reporting but need an adapter first.
export type DetectableProvider =
  | Provider
  | "icims" | "personio" | "jobvite" | "consider" | "talentzq" | "successfactors-ui5";

interface PatternDef {
  provider: DetectableProvider;
  re: RegExp;
  // careersUrl lets a pattern fall back to the careers page's own host when its match carries none (see "consider").
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
    provider: "unberry",
    // Shared host keyed by an opaque company id: app.unberry.com/careers/<companyId>.
    re: /https?:\/\/app\.unberry\.com\/careers\/[a-f0-9]+/gi,
    parse(m) {
      const u = safeUrl(m);
      if (!u) return null;
      const id = u.pathname.split("/").filter(Boolean)[1];
      return id ? { url: `https://app.unberry.com/careers/${id}`, slug: id } : null;
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
  // no pattern for turbohire/zappyhire/eightfoldpcs/ceipal/jibe/zwayam - each needs per-tenant config with no shared host signature to regex-match; registry seeding instead
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
    // deliberately not "successfactors" (a ProviderSchema member, would falsely advertise an adapter) - this is the shared-host SAPUI5 portal, a DIFFERENT engine from src/ats/successfactors.ts (legacy Jobs2Web on each tenant's own domain); detect-only until an adapter exists
    provider: "successfactors-ui5",
    re: /https?:\/\/career\d*\.successfactors\.(?:com|eu)\/career\?company=([A-Za-z0-9_-]+)/gi,
    parse(m) {
      const slug = /company=([A-Za-z0-9_-]+)/i.exec(m)?.[1];
      return slug ? { url: m, slug } : null;
    },
  },
  {
    provider: "consider",
    // Consider.co's widget usually calls a same-origin RELATIVE path rather than an absolute consider.co URL, so this falls back to the careers page's own host when the match carries none; no adapter yet
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
    // <tenant>.talentzq.io shared host (e.g. pratilipi.talentzq.io/api/1009/jd). No adapter yet.
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
    // Segment after /jobs/ is the tenant's career-site page name (usually "Careers", but tenant-chosen) - preserve it.
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
    // Tenants sit on custom domains whose pages link to "<custom-domain>.skima.ai" - strip the vendor suffix.
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

/** HTML often double-escapes ATS URLs ("https:\/\/..." in inline JSON, "&amp;" in attributes) - normalize first. */
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
