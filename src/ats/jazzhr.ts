// src/ats/jazzhr.ts — JazzHR (ApplyToJob) career boards, e.g.
// hackerearth.applytojob.com. Server-rendered HTML, no auth, no pagination
// (every posting is on the single /apply page):
//
//   list:   GET https://<tenant>.applytojob.com/apply
//           -> <ul class="list-group"><li class="list-group-item">
//                <h3 class="list-group-item-heading"><a href="{detailUrl}">{title}</a></h3>
//                <ul class="list-inline list-group-item-text"><li>{location}</li>...
//           An empty board renders "There are no open positions at this
//           time." with no list-group items — parses to []. A slug JazzHR does
//           NOT host also answers 200 with no list-group items, but only after
//           redirecting off the tenant host — see assertJazzhrOnTenantHost.
//   detail: GET {detailUrl} (https://<tenant>.applytojob.com/apply/<jobId>/<slug>)
//           -> full JD HTML in <div id="job-description">.
//
// Tenant = the subdomain, an arbitrary JazzHR account slug (the registry's
// source_slug) — not derivable from the company name.
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

/** Host of an absolute URL plus the form to compare on: a leading `www.` is
 *  cosmetic on these tenants, so `canonical` drops it while `host` keeps what was
 *  actually served for the error message. Null when `url` isn't parseable. */
function hostOf(url: string): { host: string; canonical: string } | null {
  try {
    // URL already lowercases the host and drops the path/query, so comparing
    // `canonical` is inherently insensitive to a trailing slash or a ?src=.
    const { host } = new URL(url);
    return { host, canonical: host.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/**
 * Throw when the board answered from a host other than the tenant's.
 *
 * A JazzHR slug that does not exist does NOT 404: applytojob.com answers HTTP 200
 * and redirects twice to https://www.jazzhr.com/job-seekers, JazzHR's own
 * marketing page. That page has no list-group items, so parseJazzhrList returned
 * [] and listPostings resolved with zero postings — indistinguishable from a board
 * with nothing open. Nothing failed, so consecutive_failures never moved and the
 * row stayed green forever while producing nothing.
 *
 * Keying on the host rather than on page copy means the check cannot rot when the
 * vendor rewrites its wording, and it never has to guess which page it is looking
 * at. Probed 2026-08-03 across all 8 live rows: every one stays on
 * <slug>.applytojob.com — including smuleinc, whose board is genuinely empty — and
 * only a bogus slug leaves. `base` comes from jazzhrBase so a tenant_url/api_meta
 * override sets the expected host (Smule's subdomain, smuleinc, is not its slug).
 */
export function assertJazzhrOnTenantHost(base: string, finalUrl: string): void {
  const expected = hostOf(base);
  const actual = hostOf(finalUrl);
  // An unparseable URL on either side says nothing about the board, so stay quiet
  // rather than turn a URL-shape oddity into a company failure. (A response that
  // never redirected reports no url at all; atsFetchHtml already substitutes the
  // requested URL there, which is this same tenant.)
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
    // Before parsing, not only when the parse comes up empty: a response from
    // another host is not this tenant's board whatever it happens to contain.
    assertJazzhrOnTenantHost(base, finalUrl);
    return parseJazzhrList(html, finalUrl).map((j) => normalizeJazzhr(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jazzhr" });
    return extractJazzhrJd(html);
  },
};
