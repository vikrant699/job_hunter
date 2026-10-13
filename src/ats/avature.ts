// list: GET <host>/<locale>/<portal>/SearchJobs, server-rendered HTML -> article.article--result nodes
// jd: GET .../JobDetail/[<slug>/]<id> -> full HTML in `.section__content`
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml, atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination, dateToIso, collapseWs } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { listAvaturePortal, parseAvaturePortalPage } from "./avaturePortal.js";

const MAX_PAGES = 5000;

// Avature stamps an avature.* meta tag into every portal page and serves chrome/error pages from /jscore/ - either proves the response came from the engine (see assertAvatureBoardServed)
const AVATURE_PORTAL_META_RE = /name="avature\.[a-z]/i;
const AVATURE_ASSET_RE = /\/jscore\//;

export function avatureEngineServed(html: string): boolean {
  return AVATURE_PORTAL_META_RE.test(html) || AVATURE_ASSET_RE.test(html);
}

// checked only for page 1: zero postings + no Avature markup means the board is dead, not empty; a WAF challenge is checked first so an edge block counts as infra, not a broken row
export function assertAvatureBoardServed(html: string, url: string): void {
  if (avatureEngineServed(html)) return;
  assertNotEdgeChallenge("avature", url, html);

  throw new Error(
    `avature: portal no longer served — ${url} returned a page with no job articles and none of ` +
      `Avature's own portal markup, so it is not an Avature portal and the board is dead rather ` +
      `than empty.`,
  );
}

export function avatureSearchUrl(company: AdapterCompany): string {
  const base = company.tenantUrl ?? company.careersUrl;
  const u = new URL(base);
  // optional server-side country filter (raw query suffix, e.g. "42386[]=812053"); ids are tenant-specific but the engine's own Next links carry it through every page
  const filter = company.apiMeta?.countryFilter;
  const suffix = filter !== undefined && filter !== "" ? `?${filter}` : "";
  if (/\/SearchJobs\/?$/i.test(u.pathname)) {
    u.search = "";
    u.hash = "";
    return `${u.toString()}${suffix}`;
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}/SearchJobs${suffix}`;
}

export function parseJobDetailHref(href: string): { slug: string | null; id: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/JobDetail\/(?:([^/]+)\/)?([^/]+)\/?$/i);
  if (!m?.[2]) return null;
  return { slug: m[1] ?? null, id: m[2] };
}

// Always follow this href verbatim: the offset param's NAME differs per tenant and a hand-built value is silently ignored.
export function parseAvatureNextHref(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const $next = $(".paginationNextLink").first();
  if (!$next.length) return null;
  const $a = $next.is("a") ? $next : $next.find("a").first();
  const href = $a.attr("href");
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]*$/u;
const LABEL_ONLY_RE = /^[^:]{1,40}:$/;
const LOCATION_LABEL_RE = /^(?:job\s+|work\s+)?location\s*:\s*/i;
// classed subtitle spans are named fields; the only place among them, .list-item-location, is read separately
const NAMED_FIELD_RE = /\b(?:separator|list-item-[\w-]+)\b/;
const NON_PLACE_RE = /^(?:req\s*#|(?:date\s+)?posted\b|job\s*id)/i;
const POSTED_RE = /^(?:date\s+)?posted(?:\s+since)?\s*:?\s*(.+)$/i;

interface SubtitleSpan {
  text: string;
  cls: string;
}

function stripLocationLabel(text: string): string {
  return text.replace(LOCATION_LABEL_RE, "").trim();
}

function pickLocationFromSpans(spans: SubtitleSpan[]): string | null {
  for (const { text, cls } of spans) {
    if (NAMED_FIELD_RE.test(cls) || PUNCT_ONLY_RE.test(text) || LABEL_ONLY_RE.test(text) || NON_PLACE_RE.test(text)) continue;
    const place = stripLocationLabel(text);
    if (place) return place;
  }
  return null;
}

function pickPostedFromSpans(spans: SubtitleSpan[]): string | null {
  for (const { text, cls } of spans) {
    const m = text.match(POSTED_RE);
    if (m?.[1]) return m[1].trim();
    if (/\blist-item-posted\b/.test(cls) && text) return text;
  }
  return null;
}

function pickLabelledLocation($: cheerio.CheerioAPI, $art: ReturnType<cheerio.CheerioAPI>): string | null {
  for (const field of $art.find(".article__content__field").toArray()) {
    const label = collapseWs($(field).find(".article__content__field__label").first().text());
    if (!/^(job\s+)?location\s*:?$/i.test(label)) continue;
    const value = collapseWs($(field).find(".article__content__field__value").first().text());
    if (value) return value;
  }
  return null;
}

export function parseAvatureSearch(
  html: string,
  baseUrl: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; nextHref: string | null } {
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];

  $("article.article--result").each((_, art) => {
    const $art = $(art);
    const $titleLink = $art.find(".article__header__text__title a").first();
    const href = $titleLink.attr("href");
    const title = collapseWs($titleLink.text());
    if (!href || !title) return;

    const parsed = parseJobDetailHref(href);
    if (!parsed) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    const $subtitle = $art.find(".article__header__text__subtitle").first();
    const spans: SubtitleSpan[] = $subtitle.find("span").toArray().map((el) => ({
      text: collapseWs($(el).text()),
      cls: $(el).attr("class") ?? "",
    }));

    const $loc = $subtitle.find(".list-item-location").first();
    let location: string | null;
    if ($loc.length) {
      const parts: string[] = [];
      $loc.find(".list-item-jobCity, .list-item-jobState, .list-item-jobCountry").each((_i, el) => {
        const t = collapseWs($(el).text());
        if (t) parts.push(t);
      });
      location = parts.length ? parts.join(", ") : stripLocationLabel(collapseWs($loc.text())) || null;
    } else {
      location = pickLocationFromSpans(spans) ?? pickLabelledLocation($, $art);
    }

    const postedRaw = pickPostedFromSpans(spans);

    postings.push({
      provider: "avature",
      externalId: parsed.id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: "",
      postedAt: dateToIso(postedRaw),
    });
  });

  return { postings, nextHref: parseAvatureNextHref(html, baseUrl) };
}

// prefers section.section--description .section__content; a bare .section__content first-match can grab the metadata sidebar on some skins, so it's only the fallback
export function parseAvatureJd(html: string): string {
  const $ = cheerio.load(html);
  const described = $("section.section--description .section__content").first();
  const el = described.length ? described : $(".section__content").first();
  if (!el.length) return "";
  const inner = el.html();
  return inner ? htmlToText(inner) : collapseWs(el.text());
}

const DETAIL_PLACE_LABELS = [/^(?:job\s+)?location$/i, /^city$/i, /^(?:state|province|region)$/i, /^country$/i] as const;

export function parseAvatureDetailLocation(html: string): string | null {
  const $ = cheerio.load(html);
  const ranked: { rank: number; value: string }[] = [];
  for (const field of $(".article__content__view__field").toArray()) {
    const label = collapseWs($(field).find(".article__content__view__field__label").first().text()).replace(/\s*:$/, "");
    const rank = DETAIL_PLACE_LABELS.findIndex((re) => re.test(label));
    const value = collapseWs($(field).find(".article__content__view__field__value").first().text());
    if (rank >= 0 && value) ranked.push({ rank, value });
  }
  if (!ranked.length) return null;
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.value).join(", ");
}

export const avatureAdapter: AtsAdapter = {
  provider: "avature",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const out: NormalizedPosting[] = [];
    let url: string | null = avatureSearchUrl(company);
    let page = 0;
    let hitCap = false;

    while (url) {
      if (page >= MAX_PAGES) {
        hitCap = true;
        break;
      }
      const { html, finalUrl } = await atsFetchHtml(url, { provider: "avature" });
      const { postings, nextHref } = parseAvatureSearch(html, finalUrl, company);
      // A past-the-end page can render a stale placeholder that still carries a (wrong) Next link - stop regardless.
      if (postings.length === 0) {
        if (page === 0 && parseAvaturePortalPage(html)) return listAvaturePortal(company, finalUrl);
        if (page === 0) assertAvatureBoardServed(html, finalUrl);
        break;
      }

      out.push(...postings);
      page++;
      if (!nextHref) break;

      warnDeepPagination("avature", company.slug, page, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
      url = nextHref;
    }

    if (hitCap) {
      logger.warn(
        { slug: company.slug, maxPages: MAX_PAGES },
        "avature pagination hit the runaway cap - board may be truncated"
      );
    }

    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "avature" });
    if (posting.location === null) posting.location = parseAvatureDetailLocation(html);
    return parseAvatureJd(html);
  },
};
