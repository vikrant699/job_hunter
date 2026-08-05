// src/ats/jobsoid.ts — Jobsoid career sites, e.g. cuemath.jobsoid.com.
// Server-rendered HTML board: GET https://<tenant>.jobsoid.com/ lists every
// opening on a single page (no pagination observed), grouped into department
// sections. Each posting is an `a.jobDetailsLink[href="/j/<id>/<slug>"]`
// inside an `<li>` row that also carries the location text next to a
// `.tek-address` icon. Some tenants map to a custom domain via a redirect
// (e.g. vibvzw.jobsoid.com -> jobs.vib.be) — `atsFetchHtml` follows that and
// we resolve links against the post-redirect URL. A subdomain Jobsoid does NOT
// host also redirects, but to the vendor's own shared portal — see
// assertJobsoidTenantExists.
//
// The list page doesn't carry the JD body, so `fetchJd` re-fetches the
// per-job page and pulls the description out of its clean schema.org
// JobPosting JSON-LD block.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, tenantOrigin, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

/** Pull the numeric job id out of a `/j/<id>/<slug>` href. */
export function jobsoidIdFromHref(href: string): string | null {
  return matchGroup(/\/j\/(\d+)\b/, href);
}

/**
 * Jobsoid's shared, cross-tenant job portal. Every subdomain the vendor does not
 * host redirects here, and no tenant board is ever served from it, so landing
 * here is proof the tenant is gone rather than merely idle.
 */
const JOBSOID_PORTAL_HOST = "portal.jobsoid.com";

/** Host of an absolute URL, `www.`-insensitive. Null when unparseable. */
function hostOf(url: string): string | null {
  try {
    // URL already lowercases the host and drops path/query, so comparing this
    // is inherently insensitive to a trailing slash or a ?notfound=true.
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Throw when the board was served from Jobsoid's shared portal instead of the
 * tenant.
 *
 * A Jobsoid subdomain that does not exist does NOT 404: it answers HTTP 200 and
 * redirects to https://portal.jobsoid.com/?notfound=true, the vendor's own
 * cross-tenant job search. That page carries no a.jobDetailsLink anchors, so
 * parseJobsoidList tolerated it and returned [] — listPostings resolved with zero
 * postings, indistinguishable from a board with nothing open. Nothing failed, so
 * consecutive_failures never moved and the row stayed green forever.
 *
 * Keying on the portal host specifically — rather than on "the response left the
 * tenant host" — is what keeps custom-domain tenants working: leaving the host is
 * NORMAL here (vibvzw.jobsoid.com legitimately redirects to jobs.vib.be, which
 * served 6 postings when probed 2026-08-03), so a plain off-host check would have
 * failed a healthy board. Probed across both live rows: cuemath and webbeds each
 * stay on <slug>.jobsoid.com, and cuemath is currently a live tenant rendering
 * "No Current Openings" — so a genuinely empty board still returns [], which is
 * the whole point. Only a subdomain the vendor does not host reaches the portal.
 *
 * The check runs before the parse, not only when the parse comes up empty: the
 * portal page embeds 631 postings belonging to OTHER employers, so a response
 * from there is not this tenant's board whatever it happens to contain, and
 * anything scraped off it would be attributed to the wrong company.
 */
export function assertJobsoidTenantExists(base: string, finalUrl: string): void {
  const actual = hostOf(finalUrl);
  // An unparseable URL says nothing about the board, so stay quiet rather than
  // turn a URL-shape oddity into a company failure.
  if (actual === null || actual !== JOBSOID_PORTAL_HOST) return;

  throw new Error(
    `jobsoid: tenant does not exist — ${hostOf(base) ?? base} served the board from ` +
      `${JOBSOID_PORTAL_HOST}, Jobsoid's shared cross-tenant portal, where the vendor sends ` +
      `any subdomain it does not host, so the board is dead rather than empty.`,
  );
}

/**
 * Parse the tenant's board HTML into postings. `baseUrl` should be the
 * post-redirect URL the HTML was actually served from, so relative `/j/...`
 * links resolve to the real (possibly custom-domain) host.
 */
export function parseJobsoidList(html: string, baseUrl: string, company: AdapterCompany): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();

  $("a.jobDetailsLink[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const id = jobsoidIdFromHref(href);
    if (!id || seen.has(id)) return;

    const title = collapseWs($(el).text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    seen.add(id);
    const row = $(el).closest("li");
    const location = collapseWs(row.find(".sub-title .r-space:has(i.tek-address)").first().text()) || null;

    out.push({
      provider: "jobsoid",
      externalId: id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: "",
      postedAt: null,
    });
  });

  return out;
}

/** Extract + flatten the JD body from a job detail page's JobPosting JSON-LD. */
export function jobsoidJdFromHtml(html: string): string {
  const jobs = extractJsonLdJobs(html);
  const withDescription = jobs.find((j) => j.description) ?? jobs[0];
  return htmlToText(withDescription?.description ?? "");
}

export const jobsoidAdapter: AtsAdapter = {
  provider: "jobsoid",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = tenantOrigin(company);
    const { finalUrl, html } = await atsFetchHtml(`${base}/`, { provider: "jobsoid" });
    assertJobsoidTenantExists(base, finalUrl);
    return parseJobsoidList(html, finalUrl, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jobsoid" });
    return jobsoidJdFromHtml(html);
  },
};
