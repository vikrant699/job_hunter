// src/ats/jazzhr.ts — JazzHR (ApplyToJob) career boards, e.g.
// hackerearth.applytojob.com. Server-rendered HTML, no auth, no pagination
// (every posting is on the single /apply page):
//
//   list:   GET https://<tenant>.applytojob.com/apply
//           -> <ul class="list-group"><li class="list-group-item">
//                <h3 class="list-group-item-heading"><a href="{detailUrl}">{title}</a></h3>
//                <ul class="list-inline list-group-item-text"><li>{location}</li>...
//           An empty board renders "There are no open positions at this
//           time." with no list-group items — parses to [].
//   detail: GET {detailUrl} (https://<tenant>.applytojob.com/apply/<jobId>/<slug>)
//           -> full JD HTML in <div id="job-description">.
//
// Tenant = the subdomain, an arbitrary JazzHR account slug (the registry's
// source_slug) — not derivable from the company name.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE, tenantOriginOr } from "./shared.js";
import { matchGroup } from "../util/regex.js";

/** Tenant origin, e.g. "https://hackerearth.applytojob.com". Prefers an
 *  explicit tenant_url host when set, else builds it from the slug (the
 *  subdomain — an arbitrary JazzHR account name). */
export function jazzhrBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.applytojob.com`);
}

export interface JazzhrListing {
  id: string;
  title: string;
  url: string;
  location: string | null;
}

/** The job id is the first path segment after /apply/ on a detail URL
 *  (/apply/<id>/<slug>). Null for URLs with no such shape (e.g. the board
 *  index itself). */
export function parseJazzhrJobId(url: string): string | null {
  return matchGroup(/\/apply\/([^/]+)\/[^/]+/, url);
}

/** Parse the /apply board page into raw listings. Pure — unit tested.
 *  Tolerates rows with a missing href or blank title by skipping them,
 *  rather than throwing on one malformed row. */
export function parseJazzhrList(html: string, baseUrl: string): JazzhrListing[] {
  const $ = cheerio.load(html);
  const out: JazzhrListing[] = [];

  $("ul.list-group > li.list-group-item").each((_, el) => {
    const anchor = $(el).find("h3.list-group-item-heading a").first();
    const href = anchor.attr("href");
    if (!href) return;

    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    const id = parseJazzhrJobId(url);
    if (!id) return;

    const title = anchor.text().trim().replace(/\s+/g, " ");
    if (!title) return;

    const locationText = $(el)
      .find("ul.list-inline.list-group-item-text li")
      .first()
      .text()
      .trim();

    out.push({ id, title, url, location: locationText || null });
  });

  return out;
}

export function normalizeJazzhr(company: AdapterCompany, j: JazzhrListing): NormalizedPosting {
  return {
    provider: "jazzhr",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.url,
    location: j.location,
    isRemote: j.location ? REMOTE_RE.test(j.location) : false,
    jdText: "",
    postedAt: null,
  };
}

/** Extract the plain-text JD from a detail page's #job-description div.
 *  Pure — unit tested. Empty string when the div is missing. */
export function extractJazzhrJd(html: string): string {
  const $ = cheerio.load(html);
  const body = $("#job-description").first().html();
  return htmlToText(body);
}

export const jazzhrAdapter: AtsAdapter = {
  provider: "jazzhr",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = jazzhrBase(company);
    const { html, finalUrl } = await atsFetchHtml(`${base}/apply`, { provider: "jazzhr" });
    return parseJazzhrList(html, finalUrl).map((j) => normalizeJazzhr(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jazzhr" });
    return extractJazzhrJd(html);
  },
};
