// src/ats/trakstar.ts — Trakstar Hire career sites, one tenant per subdomain:
// <tenant>.hire.trakstar.com. The board is server-rendered, no auth:
//
//   list: GET <origin>/?p=<N> -> a server-paginated page of postings (25 on
//         the tenants seen so far, but `?p=N` states no size, so the loop
//         infers it from page 1 rather than assuming). The pagination param is
//         `p` (NOT `page`, which is silently ignored); the bare origin is
//         page 1. Follow `?p=2,3,...` until a short/empty page.
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
    // Server-paginated via `?p=N`; follow pages until a short/empty one.
    // `total` isn't exposed, so termination relies on the short-page rule plus
    // the exact-page-repeat stall guard.
    return paginate<NormalizedPosting>({
      provider: "trakstar",
      company: company.slug,
      // `?p=N` carries no page size, so 25 was an assumption about the product
      // rather than anything the tenant told us: a tenant serving fewer had
      // page 1 judged short and the board stopped there. Latch the tenant's
      // own first-page row count instead.
      pageSize: "infer",
      // Collapses a slug served on more than one page (previously a filter
      // applied after paginate returned — same key, same first-wins order).
      // Doing it inside paginate also arms the exact-page-repeat stall guard,
      // which needs a stable per-item key: with no total published and every
      // page full, a board that clamps an out-of-range `p` back to page 1 has
      // nothing else to stop it before the runaway cap.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(trakstarListUrl(company, page + 1), { provider: "trakstar" });
        const items = parseTrakstarList(html, company);
        return { items, total: null, rawCount: items.length };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "trakstar" });
    return parseTrakstarJd(html);
  },
};
