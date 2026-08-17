// src/ats/trakstar.ts — Trakstar Hire career sites, one tenant per subdomain
// (<tenant>.hire.trakstar.com), server-rendered, no auth. list: GET <origin>/?p=<N>
// (pagination param is `p`, NOT `page`, which is silently ignored); follow until a
// short/empty page. Each posting is a .js-careers-page-job-list-item with an
// <a href="/jobs/<slug>/">, the slug being the stable external id (no numeric job id).
// jd: GET <origin>/jobs/<slug>/ -> full HTML in div.jobdesciption (vendor's own misspelling).
// A never-existed subdomain 404s; a CANCELLED tenant answers 200 — see INACTIVE_ACCOUNT_SELECTOR.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin, collapseWs } from "./shared.js";

// Listing page N (1-based). Page 1 is the bare origin (== ?p=1).
export function trakstarListUrl(company: AdapterCompany, page = 1): string {
  const base = tenantOrigin(company);
  return page <= 1 ? base : `${base}/?p=${page}`;
}

// slug from a "/jobs/<slug>/" href. Null when the shape doesn't match.
export function parseTrakstarHref(href: string): { slug: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "jobs") return null;
  const slug = segs[1];
  if (!slug) return null;
  return { slug };
}

// A cancelled tenant's subdomain keeps serving HTTP 200 with an "Inactive account" notice
// instead of the board, which used to parse as a healthy zero-job board and never
// quarantine. The marker is the page's canonical link pointing at Trakstar's shared
// /inactive-ats notice — machine-readable, present only there, absent on serving boards
// and on the 404 a never-existed subdomain returns.
const INACTIVE_ACCOUNT_SELECTOR = 'link[rel="canonical"][href*="inactive-ats"]';

// Tolerates a missing location; skips rows missing an href/slug/title; dedupes by slug.
// Throws when the page is Trakstar's inactive-account notice — see INACTIVE_ACCOUNT_SELECTOR.
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

  // Checked only after the parse comes up empty, so a page that yielded rows is a live tenant regardless.
  if (postings.length === 0 && $(INACTIVE_ACCOUNT_SELECTOR).length > 0) {
    throw new Error(
      `trakstar: tenant does not exist at ${trakstarListUrl(company)} — Trakstar served its ` +
        `inactive-account notice ("no longer using Trakstar Hire to collect applications"). ` +
        `The board is cancelled, not empty.`,
    );
  }

  return postings;
}

// Extracts the JD body (div.jobdesciption — the vendor's misspelling) as plain text.
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
    // Server-paginated via `?p=N`; `total` isn't exposed, so termination relies on the
    // short-page rule plus the exact-page-repeat stall guard.
    return paginate<NormalizedPosting>({
      provider: "trakstar",
      company: company.slug,
      // `?p=N` carries no page size; latch the tenant's own first-page row count instead of assuming 25.
      pageSize: "infer",
      // Arms the exact-page-repeat stall guard: without a stable per-item key, a tenant
      // that clamps an out-of-range `p` back to page 1 has nothing to stop it before the runaway cap.
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
