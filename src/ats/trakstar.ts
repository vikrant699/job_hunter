// src/ats/trakstar.ts — Trakstar Hire career sites, one tenant per subdomain:
// <tenant>.hire.trakstar.com. The board is server-rendered, no auth:
//
//   list: GET <origin>/?p=<N> -> 25 postings per page, server-paginated. The
//         pagination param is `p` (NOT `page`, which is silently ignored); the
//         bare origin is page 1. Follow `?p=2,3,...` until a short/empty page.
//         Each posting is a
//           <div class="js-careers-page-job-list-item">
//         wrapping an <h3 class="js-job-list-opening-name"> title, an
//         optional `.meta-job-location-city` location, and an
//         <a href="/jobs/<slug>/"> to the detail page. The slug is the
//         stable external id — Trakstar has no separate numeric job id.
//
//   jd:   GET <origin>/jobs/<slug>/ -> full rich HTML in
//         `div.jobdesciption` (vendor's own misspelling — not "jobdescription").
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin, collapseWs } from "./shared.js";

const PAGE_SIZE = 25; // server-fixed page size

/** Listing page N (1-based). Page 1 is the bare origin (== ?p=1). */
export function trakstarListUrl(company: AdapterCompany, page = 1): string {
  const base = tenantOrigin(company);
  return page <= 1 ? base : `${base}/?p=${page}`;
}

/** slug from a "/jobs/<slug>/" href. Null when the shape doesn't match. */
export function parseTrakstarHref(href: string): { slug: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "jobs") return null;
  const slug = segs[1];
  if (!slug) return null;
  return { slug };
}

/** Parse the listing page into postings. Tolerates a missing location and
 *  skips any row missing an href, slug, or title. Dedups by slug in case
 *  markup ever renders a row twice. */
export function parseTrakstarList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const base = tenantOrigin(company);
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];
  const seen = new Set<string>();

  $(".js-careers-page-job-list-item").each((_, el) => {
    const $row = $(el);
    const href = $row.find("a[href]").first().attr("href");
    if (!href) return;

    const parsed = parseTrakstarHref(href);
    if (!parsed) return;
    if (seen.has(parsed.slug)) return;

    const title = collapseWs($row.find(".js-job-list-opening-name").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, base).toString();
    } catch {
      return;
    }

    const location = collapseWs($row.find(".meta-job-location-city").first().text()) || null;
    const isRemote = location ? REMOTE_RE.test(location) : false;

    seen.add(parsed.slug);
    postings.push({
      provider: "trakstar",
      externalId: parsed.slug,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl,
      location,
      isRemote,
      jdText: "",
      postedAt: null,
    });
  });

  return postings;
}

/** Extract the JD body (`div.jobdesciption` — the vendor's misspelling) as plain text. */
export function parseTrakstarJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $("div.jobdesciption").first();
  if (!el.length) return "";
  const inner = el.html();
  return inner ? htmlToText(inner) : collapseWs(el.text());
}

export const trakstarAdapter: AtsAdapter = {
  provider: "trakstar",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // Server-paginated at 25/page via `?p=N`; follow pages until a short/empty
    // one. `total` isn't exposed, so termination relies on the short-page rule.
    const pages = await paginate<NormalizedPosting>({
      provider: "trakstar",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(trakstarListUrl(company, page + 1), { provider: "trakstar" });
        const items = parseTrakstarList(html, company);
        return { items, total: null, rawCount: items.length };
      },
    });
    // paginate accumulates across pages without cross-page dedup; collapse any
    // slug that appears on more than one page (defensive — pages don't overlap
    // in practice).
    const seen = new Set<string>();
    return pages.filter((p) => (seen.has(p.externalId) ? false : (seen.add(p.externalId), true)));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "trakstar" });
    return parseTrakstarJd(html);
  },
};
