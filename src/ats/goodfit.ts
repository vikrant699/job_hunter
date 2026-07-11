// src/ats/goodfit.ts — Goodfit job boards (Springworks' own ATS), one tenant per
// path: https://app.goodfit.so/jobs/<slug>. Two server-rendered generations exist:
//
//   v2 (migrated tenants, e.g. springworks, infiniti-solutions): the v1 URL
//      serves a shell that meta-refreshes to https://v2.app.goodfit.so/jobs/<slug>.
//      The v2 page carries a JSON-LD ItemList (title + absolute job URL with
//      ?id=<uuid>) AND an RSC flight-data island {\"jobs\":[...]} with locations,
//      createdAt, seniority. Titles/urls come from the JSON-LD; locations/dates
//      from the island. The DOM shows "Remote" for jobs with NO locations —
//      that default is deliberately ignored (location stays null).
//
//   v1 (non-migrated tenants, e.g. giva): jobs render as
//      <a href="/jobs/<slug>/<Title>?id=<shortid>"> cards with the title in a
//      div.font-serif.font-medium and "Org ✦ City, State, Country" beneath.
//
//   jd: the per-job page is server-rendered on both generations. v2 keeps the
//       body in div.prose; v1 in a font-serif div styled with [&>h1]:... rules.
//       Fallback: whole-page text. Everything is a single page — no pagination
//       has been observed on either generation (boards render all jobs at once).
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema } from "../util/json.js";
import { htmlToText } from "./html-text.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE } from "./shared.js";

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

/**
 * v2 RSC flight-data island: the page streams `self.__next_f.push([1,"...{\"jobs\":[...]}..."])`
 * — a JSON payload escaped inside a JS string literal. Balanced-brace scan the
 * escaped text, unescape it AS a JSON string literal, then parse. Per-job
 * tolerant: an odd job shape is skipped, not fatal. Returns id -> {locations, createdAt}.
 */
export function extractGoodfitRscJobs(html: string): Map<string, GoodfitRscJob> {
  const map = new Map<string, GoodfitRscJob>();
  const start = html.indexOf('{\\"jobs\\":[');
  if (start < 0) return map;

  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return map;

  let parsed: unknown;
  try {
    const unescaped: unknown = JSON.parse(`"${html.slice(start, end)}"`);
    if (typeof unescaped !== "string") return map;
    parsed = JSON.parse(unescaped);
  } catch {
    return map;
  }

  const envelope = z.object({ jobs: z.array(JsonValueSchema) }).safeParse(parsed);
  if (!envelope.success) return map;
  for (const raw of envelope.data.jobs) {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      return;
    }
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

function goodfitIso(createdAt: string | null): string | null {
  if (!createdAt) return null;
  const d = new Date(createdAt); // e.g. "2026-06-22 11:39:05.63+00"
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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

/**
 * Parse one board page (either generation) into postings.
 * v2: JSON-LD titles/urls merged with RSC locations/createdAt.
 * v1: server-rendered anchor cards.
 * Throws on Next's 404 fallback (board slug gone); [] is a legitimately empty board.
 */
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
      const locations = meta?.locations ?? [];
      out.push(
        makePosting(company, {
          externalId: id,
          title: item.name,
          jobUrl: new URL(item.url, finalUrl).toString(),
          location: locations.length > 0 ? locations.join("; ") : null,
          postedAt: goodfitIso(meta?.createdAt ?? null),
        }),
      );
    }
    return out;
  }

  // v1 fallback: anchor cards. Title in div.font-serif (v1) or span.font-medium (v2
  // safety net); location after the ✦ separator (v1) or in the span.text-xs chip (v2).
  const $ = cheerio.load(html);
  $('a[href*="?id="]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || !/\/jobs\//.test(href)) return;
    const id = goodfitJobId(href, finalUrl);
    if (!id || seen.has(id)) return;

    const title =
      cleanText($a.find("div.font-serif").first().text()) || cleanText($a.find("span.font-medium").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, finalUrl).toString();
    } catch {
      return;
    }

    let location: string | null = null;
    const subtitle = cleanText($a.find("div.text-xs").first().text());
    const afterStar = subtitle.split("✦")[1];
    if (afterStar && afterStar.trim()) {
      location = afterStar.trim();
    } else {
      location = cleanText($a.find("span.text-xs").first().text()) || null;
    }

    seen.add(id);
    out.push(makePosting(company, { externalId: id, title, jobUrl, location, postedAt: null }));
  });

  return out;
}

/** JD text from a detail page: div.prose (v2), else the [&>h1]-styled container (v1),
 *  else whole-page text minus scripts/styles. */
export function extractGoodfitJd(html: string): string {
  const $ = cheerio.load(html);
  $("script, style").remove();
  const container = $("div.prose").first().length > 0 ? $("div.prose").first() : $('div[class*="h1]:"]').first();
  const target = container.length > 0 ? container.html() : $("body").html();
  return htmlToText(target ?? "");
}

/** Fetch a goodfit page, following embedded client-side redirects (v1 board shell
 *  -> v2 board; v1 job page -> /j/<shortid> interstitial -> v2 job page). Meta
 *  refresh targets can be relative, so each hop resolves against the previous URL. */
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
