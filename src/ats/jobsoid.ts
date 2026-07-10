// src/ats/jobsoid.ts — Jobsoid career sites, e.g. cuemath.jobsoid.com.
// Server-rendered HTML board: GET https://<tenant>.jobsoid.com/ lists every
// opening on a single page (no pagination observed), grouped into department
// sections. Each posting is an `a.jobDetailsLink[href="/j/<id>/<slug>"]`
// inside an `<li>` row that also carries the location text next to a
// `.tek-address` icon. Some tenants map to a custom domain via a redirect
// (e.g. vibvzw.jobsoid.com -> jobs.vib.be) — `atsFetchHtml` follows that and
// we resolve links against the post-redirect URL.
//
// The list page doesn't carry the JD body, so `fetchJd` re-fetches the
// per-job page and pulls the description out of its clean schema.org
// JobPosting JSON-LD block.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchHtml } from "./http.js";
import { extractJsonLdJobs } from "../scraper/json-ld.js";
import { REMOTE_RE } from "./shared.js";

/** Tenant origin, e.g. "https://cuemath.jobsoid.com". */
export function jobsoidOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** Pull the numeric job id out of a `/j/<id>/<slug>` href. */
export function jobsoidIdFromHref(href: string): string | null {
  const m = href.match(/\/j\/(\d+)\b/);
  return m ? m[1]! : null;
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

    const title = $(el).text().trim().replace(/\s+/g, " ");
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    seen.add(id);
    const row = $(el).closest("li");
    const location = row.find(".sub-title .r-space:has(i.tek-address)").first().text().trim().replace(/\s+/g, " ") || null;

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
    const { finalUrl, html } = await atsFetchHtml(`${jobsoidOrigin(company)}/`, { provider: "jobsoid" });
    return parseJobsoidList(html, finalUrl, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jobsoid" });
    return jobsoidJdFromHtml(html);
  },
};
