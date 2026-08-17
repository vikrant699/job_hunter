// src/ats/jazzhr.ts — JazzHR (ApplyToJob) career boards (<tenant>.applytojob.com), server-rendered HTML,
// no auth, no pagination (all postings on one /apply page).
// A nonexistent tenant slug answers HTTP 200 but redirects off-host to JazzHR's own marketing page — see
// assertJazzhrOnTenantHost. detail: GET /apply/<id>/<slug> -> #job-description.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE, tenantOriginOr, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

/** Tenant origin, e.g. "https://hackerearth.applytojob.com". Prefers an
 *  explicit tenant_url host when set, else builds it from the slug (the
 *  subdomain — an arbitrary JazzHR account name). */
export function jazzhrBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.applytojob.com`);
}

/** Host of a URL plus a www.-stripped canonical form for comparison; null when unparseable. */
function hostOf(url: string): { host: string; canonical: string } | null {
  try {
    // URL already lowercases the host and drops the path/query, so `canonical` is insensitive to a trailing slash or a ?src=.
    const { host } = new URL(url);
    return { host, canonical: host.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/** Throw when the board answered off the tenant host: a dead JazzHR slug doesn't 404, it 200s and
 *  redirects to JazzHR's own marketing page (no list-group items), which used to read as a healthy empty
 *  board forever. Keyed on host rather than page copy so it can't rot when the vendor rewrites wording;
 *  `base` comes from jazzhrBase so a tenant_url/apiMeta override sets the expected host. */
export function assertJazzhrOnTenantHost(base: string, finalUrl: string): void {
  const expected = hostOf(base);
  const actual = hostOf(finalUrl);
  // An unparseable URL on either side says nothing about the board, so stay quiet rather than turn a
  // URL-shape oddity into a company failure.
  if (expected === null || actual === null) return;
  if (expected.canonical === actual.canonical) return;

  throw new Error(
    `jazzhr: tenant does not exist — ${expected.host} redirected to ${actual.host}, off the ` +
      `tenant host (JazzHR serves its own marketing page for a slug it does not host), so the ` +
      `board is dead, not empty.`,
  );
}

export interface JazzhrListing {
  id: string;
  title: string;
  url: string;
  location: string | null;
}

/** The job id is the first path segment after /apply/ on a detail URL (/apply/<id>/<slug>); null otherwise. */
export function parseJazzhrJobId(url: string): string | null {
  return matchGroup(/\/apply\/([^/]+)\/[^/]+/, url);
}

/** Parse the /apply board page into raw listings; skips rows with a missing href or blank title. */
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

/** Extract the plain-text JD from a detail page's #job-description div; "" when the div is missing. */
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
    return parseJazzhrList(html, finalUrl).map((j) => normalizeJazzhr(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jazzhr" });
    return extractJazzhrJd(html);
  },
};
