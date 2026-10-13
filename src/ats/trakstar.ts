// List: GET <origin>/?p=<N> (server-rendered, no auth); the param is `p`, NOT `page` (silently ignored); stop on a short/empty page. Postings are .js-careers-page-job-list-item with <a href="/jobs/<slug>/">, slug is the stable id.
// JD: GET <origin>/jobs/<slug>/ -> div.jobdesciption (vendor's own misspelling).
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin, collapseWs } from "./shared.js";

export function trakstarListUrl(company: AdapterCompany, page = 1): string {
  const base = tenantOrigin(company);
  return page <= 1 ? base : `${base}/?p=${page}`;
}

export function parseTrakstarHref(href: string): { slug: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "jobs") return null;
  const slug = segs[1];
  if (!slug) return null;
  return { slug };
}

// A cancelled tenant keeps serving 200 with an "Inactive account" notice; the marker is a canonical link to Trakstar's shared /inactive-ats page.
const INACTIVE_ACCOUNT_SELECTOR = 'link[rel="canonical"][href*="inactive-ats"]';

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

  if (postings.length === 0 && $(INACTIVE_ACCOUNT_SELECTOR).length > 0) {
    throw new Error(
      `trakstar: tenant does not exist at ${trakstarListUrl(company)} — Trakstar served its ` +
        `inactive-account notice ("no longer using Trakstar Hire to collect applications"). ` +
        `The board is cancelled, not empty.`,
    );
  }

  return postings;
}

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
    // `total` isn't exposed: termination is the short-page rule plus the exact-page-repeat stall guard.
    return paginate<NormalizedPosting>({
      provider: "trakstar",
      company: company.slug,
      // `?p=N` carries no page size, so latch the tenant's first-page row count instead of assuming 25.
      pageSize: "infer",
      // Arms the stall guard: without a stable per-item key, a tenant clamping an out-of-range `p` to page 1 has nothing to stop it before the runaway cap.
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
