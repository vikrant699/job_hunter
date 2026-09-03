// list: <tenant>.jobsoid.com, server-rendered, all postings on one page (no pagination observed); some tenants redirect to a custom domain
// jd: re-fetches the per-job page's schema.org JobPosting JSON-LD (list page has no JD)
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

// Jobsoid's shared, cross-tenant job portal; every subdomain the vendor does not host redirects here, and no tenant board is ever served from it.
const JOBSOID_PORTAL_HOST = "portal.jobsoid.com";

/** Host of an absolute URL, `www.`-insensitive. Null when unparseable. */
function hostOf(url: string): string | null {
  try {
    // URL already lowercases the host and drops path/query, so comparing this is inherently insensitive to a trailing slash or a ?notfound=true.
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Throws when the board was served from JOBSOID_PORTAL_HOST instead of the tenant: a dead subdomain 200s and redirects there instead of 404ing, and the portal embeds other employers' postings, so this must be checked before parsing. */
export function assertJobsoidTenantExists(base: string, finalUrl: string): void {
  const actual = hostOf(finalUrl);
  // An unparseable URL says nothing about the board, so stay quiet rather than turn it into a company failure.
  // Keyed on the portal host specifically (not "left the tenant host") since custom-domain redirects are normal and legitimate here.
  if (actual === null || actual !== JOBSOID_PORTAL_HOST) return;

  throw new Error(
    `jobsoid: tenant does not exist — ${hostOf(base) ?? base} served the board from ` +
      `${JOBSOID_PORTAL_HOST}, Jobsoid's shared cross-tenant portal, where the vendor sends ` +
      `any subdomain it does not host, so the board is dead rather than empty.`,
  );
}

/** Parse the tenant's board HTML into postings; `baseUrl` should be the post-redirect URL so relative `/j/...` links resolve to the real (possibly custom-domain) host. */
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
    // Per-item location next to the address icon; some tenants have none and instead group jobs under `.list-title` headers — inherit the nearest preceding group title in that case.
    const perItem = collapseWs(row.find(".sub-title .r-space:has(i.tek-address)").first().text());
    const groupTitle = perItem === "" ? collapseWs(row.closest("ul.list").prevAll(".list-title").first().text()) : "";
    const location = perItem || groupTitle || null;

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
