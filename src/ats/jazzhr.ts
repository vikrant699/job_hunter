// list: GET <tenant>.applytojob.com/apply -> server-rendered HTML, no auth, no pagination (all postings on one page)
// jd: GET /apply/<id>/<slug> -> #job-description; a dead tenant slug 200s and redirects off-host instead of 404ing (see assertJazzhrOnTenantHost)
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE, tenantOriginOr, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

export function jazzhrBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.applytojob.com`);
}

function hostOf(url: string): { host: string; canonical: string } | null {
  try {
    const { host } = new URL(url);
    return { host, canonical: host.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/** Throws when the board answered off the tenant host: a dead slug 200s and redirects to JazzHR's marketing page; keyed on host so vendor rewording can't break it. */
export function assertJazzhrOnTenantHost(base: string, finalUrl: string): void {
  const expected = hostOf(base);
  const actual = hostOf(finalUrl);
  if (expected === null || actual === null) return;
  if (expected.canonical === actual.canonical) return;

  throw new Error(
    `jazzhr: tenant does not exist — ${expected.host} redirected to ${actual.host}, off the ` +
      `tenant host (JazzHR serves its own marketing page for a slug it does not host), so the ` +
      `board is dead, not empty.`,
  );
}

/** Throws on JazzHR's inactive-account page: a cancelled account still 200s with no list, reading as an empty board. */
export function assertJazzhrAccountActive(html: string, url: string): void {
  const title = matchGroup(/<title[^>]*>([^<]*)<\/title>/i, html) ?? "";
  if (!/inactive career page/i.test(title)) return;
  throw new Error(`jazzhr: account no longer active at ${url} (JazzHR "Inactive Career Page"), so the board is dead, not empty.`);
}

export interface JazzhrListing {
  id: string;
  title: string;
  url: string;
  location: string | null;
}

export function parseJazzhrJobId(url: string): string | null {
  return matchGroup(/\/apply\/([^/]+)\/[^/]+/, url);
}

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

    const title = collapseWs(anchor.text());
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
    // Before parsing, not only when empty: a response from another host is not this tenant's board.
    assertJazzhrOnTenantHost(base, finalUrl);
    assertJazzhrAccountActive(html, finalUrl);
    return parseJazzhrList(html, finalUrl).map((j) => normalizeJazzhr(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jazzhr" });
    return extractJazzhrJd(html);
  },
};
