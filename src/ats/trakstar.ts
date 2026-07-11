// src/ats/trakstar.ts — Trakstar Hire career sites, one tenant per subdomain:
// <tenant>.hire.trakstar.com. The board is server-rendered, no auth:
//
//   list: GET <origin>/ -> ALL postings inline in one page, no pagination
//         (?page=2 is ignored). Each posting is a
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
import { REMOTE_RE } from "./shared.js";

/** Origin (https://<tenant>.hire.trakstar.com) from the tenant/careers URL. */
export function trakstarBase(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** The one (unpaginated) listing page. */
export function trakstarListUrl(company: AdapterCompany): string {
  return trakstarBase(company);
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
  const base = trakstarBase(company);
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

    const title = cleanText($row.find(".js-job-list-opening-name").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, base).toString();
    } catch {
      return;
    }

    const location = cleanText($row.find(".meta-job-location-city").first().text()) || null;
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
  return inner ? htmlToText(inner) : cleanText(el.text());
}

export const trakstarAdapter: AtsAdapter = {
  provider: "trakstar",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(trakstarListUrl(company), { provider: "trakstar" });
    return parseTrakstarList(html, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "trakstar" });
    return parseTrakstarJd(html);
  },
};
