// list: v2 JSON-LD ItemList + RSC flight-data island (locations/createdAt), else v1 server-rendered anchor cards; no pagination on either generation
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, tryParseJson } from "../util/json.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE, dateToIso, collapseWs, extractBalanced } from "./shared.js";

const BOARD_ORIGIN = "https://app.goodfit.so";

/** Board slug: path segment after /jobs/ in tenantUrl/careersUrl, else company slug. */
export function goodfitSlug(company: AdapterCompany): string {
  for (const url of [company.tenantUrl, company.careersUrl]) {
    if (!url) continue;
    try {
      const segs = new URL(url).pathname.split("/").filter(Boolean);
      const i = segs.indexOf("jobs");
      const slug = i >= 0 ? segs[i + 1] : undefined;
      if (slug) return slug;
    } catch {
      /* try next */
    }
  }
  return company.slug;
}

/** Board URL to fetch: explicit tenant/careers URL when it points at a board, else canonical. */
export function goodfitBoardUrl(company: AdapterCompany): string {
  for (const url of [company.tenantUrl, company.careersUrl]) {
    if (url && /goodfit\.so\/jobs\//i.test(url)) return url;
  }
  return `${BOARD_ORIGIN}/jobs/${encodeURIComponent(goodfitSlug(company))}`;
}

/** Client-side redirect target (meta refresh, else Next's RSC redirect digest). */
export function extractGoodfitRedirect(html: string): string | null {
  const meta = html.match(/http-equiv="refresh"[^>]*content="\d+;\s*url=([^"]+)"/i);
  if (meta?.[1]) return meta[1];
  const rsc = html.match(/NEXT_REDIRECT;replace;(https?:\/\/[^;]+);\d+/);
  return rsc?.[1] ?? null;
}

const RscJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  createdAt: z.string().nullable().optional(),
  locations: z.array(z.string()).nullable().optional(),
});

export interface GoodfitRscJob {
  locations: string[];
  createdAt: string | null;
}

/** v2 RSC flight-data island: JSON is escaped inside a JS string, unescaped once before balanced-scanning "jobs" so a job's own string fields (e.g. title) can't miscount the scan. */
export function extractGoodfitRscJobs(html: string): Map<string, GoodfitRscJob> {
  const map = new Map<string, GoodfitRscJob>();
  const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\\//g, "/");
  const text = extractBalanced(unescaped, '{"jobs":', "[");
  if (!text) return map;

  const parsed = tryParseJson(text);
  if (parsed === null) return map;

  const jobs = z.array(JsonValueSchema).safeParse(parsed);
  if (!jobs.success) return map;
  for (const raw of jobs.data) {
    const job = RscJobSchema.safeParse(raw);
    if (!job.success) continue;
    map.set(String(job.data.id), {
      locations: job.data.locations ?? [],
      createdAt: job.data.createdAt ?? null,
    });
  }
  return map;
}

export interface GoodfitLdItem {
  name: string;
  url: string;
}

const LdListItemSchema = z.object({
  url: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
const LdItemListSchema = z.object({
  "@type": z.literal("ItemList"),
  itemListElement: z.array(LdListItemSchema),
});

/** v2 JSON-LD ItemList -> [{name, url}]. Empty when absent (v1 boards). */
export function parseGoodfitLdItems(html: string): GoodfitLdItem[] {
  const $ = cheerio.load(html);
  const out: GoodfitLdItem[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out.length > 0) return;
    const parsed = tryParseJson($(el).text());
    if (parsed === null) return;
    const ld = LdItemListSchema.safeParse(parsed);
    if (!ld.success) return;
    for (const item of ld.data.itemListElement) {
      if (item.name && item.url) out.push({ name: item.name, url: item.url });
    }
  });
  return out;
}

/** Stable external id from a job URL's ?id= param; falls back to the last path segment. */
function goodfitJobId(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    return u.searchParams.get("id") ?? u.pathname.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

function makePosting(
  company: AdapterCompany,
  fields: { externalId: string; title: string; jobUrl: string; location: string | null; postedAt: string | null },
): NormalizedPosting {
  return {
    provider: "goodfit",
    externalId: fields.externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: fields.title,
    jobUrl: fields.jobUrl,
    location: fields.location,
    isRemote: fields.location !== null && REMOTE_RE.test(fields.location),
    jdText: "", // detail page fetched lazily via fetchJd
    postedAt: fields.postedAt,
  };
}

/** Parse one board page (either generation) into postings; throws on Next's 404 fallback (board slug gone), [] is a legitimately empty board. */
export function parseGoodfitBoard(html: string, finalUrl: string, company: AdapterCompany): NormalizedPosting[] {
  if (html.includes("NEXT_HTTP_ERROR_FALLBACK;404")) {
    throw new Error(`goodfit board 404 for ${company.slug} (${finalUrl})`);
  }

  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  const rsc = extractGoodfitRscJobs(html);

  const ldItems = parseGoodfitLdItems(html);
  if (ldItems.length > 0) {
    for (const item of ldItems) {
      const id = goodfitJobId(item.url, finalUrl);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const meta = rsc.get(id);
      const locations = meta?.locations ?? []; // DOM's "Remote" default for jobs with no locations is deliberately not used here
      out.push(
        makePosting(company, {
          externalId: id,
          title: item.name,
          jobUrl: new URL(item.url, finalUrl).toString(),
          location: locations.length > 0 ? locations.join("; ") : null,
          postedAt: dateToIso(meta?.createdAt ?? null),
        }),
      );
    }
    return out;
  }

  // v1 fallback: anchor cards, title in div.font-serif or span.font-medium, location after the ✦ separator or in the span.text-xs chip.
  const $ = cheerio.load(html);
  $('a[href*="?id="]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || !/\/jobs\//.test(href)) return;
    const id = goodfitJobId(href, finalUrl);
    if (!id || seen.has(id)) return;

    const title =
      collapseWs($a.find("div.font-serif").first().text()) || collapseWs($a.find("span.font-medium").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, finalUrl).toString();
    } catch {
      return;
    }

    let location: string | null = null;
    const subtitle = collapseWs($a.find("div.text-xs").first().text());
    const afterStar = subtitle.split("✦")[1];
    if (afterStar && afterStar.trim()) {
      location = afterStar.trim();
    } else {
      location = collapseWs($a.find("span.text-xs").first().text()) || null;
    }

    seen.add(id);
    out.push(makePosting(company, { externalId: id, title, jobUrl, location, postedAt: null }));
  });

  return out;
}

/** JD text: div.prose (v2), else [&>h1]-styled container (v1), else whole-page text minus scripts/styles. */
export function extractGoodfitJd(html: string): string {
  const $ = cheerio.load(html);
  $("script, style").remove();
  const container = $("div.prose").first().length > 0 ? $("div.prose").first() : $('div[class*="h1]:"]').first();
  const target = container.length > 0 ? container.html() : $("body").html();
  return htmlToText(target ?? "");
}

/** Fetch a goodfit page, following embedded client-side redirects (v1 shell -> v2 board/job); meta refresh targets can be relative, resolved against the previous URL. */
async function fetchGoodfitPage(url: string): Promise<{ finalUrl: string; html: string }> {
  let page = await atsFetchHtml(url, { provider: "goodfit" });
  for (let hop = 0; hop < 3; hop++) {
    const redirect = extractGoodfitRedirect(page.html);
    if (!redirect) break;
    page = await atsFetchHtml(new URL(redirect, page.finalUrl).toString(), { provider: "goodfit" });
  }
  return page;
}

export const goodfitAdapter: AtsAdapter = {
  provider: "goodfit",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const { finalUrl, html } = await fetchGoodfitPage(goodfitBoardUrl(company));
    return parseGoodfitBoard(html, finalUrl, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await fetchGoodfitPage(posting.jobUrl);
    return extractGoodfitJd(html);
  },
};
