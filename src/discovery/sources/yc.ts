import * as cheerio from "cheerio";
import { config } from "../../config.js";
import { profile } from "../../profile.js";
import { logger } from "../../logger.js";
import { fetchHtmlPlaywright } from "../../scraper/playwright.js";
import { BROWSER_UA } from "../../util/user-agent.js";

// Hosts that appear on a YC company page but are never the company's own site.
const NON_WEBSITE_HOST_RE =
  /(ycombinator|workatastartup|bookface|ycdn|twitter|x\.com|linkedin|github|youtube|youtu\.be|facebook|instagram|crunchbase|techcrunch|startupschool|medium\.com|google|gstatic|googleapis|apple\.com|schema\.org|w3\.org|gravatar|cloudfront|gumlet)/i;

/**
 * Extract a company's real website from its YC detail-page HTML. YC links the
 * site several times (logo, header, "visit website"), so the most-frequent
 * external non-social host is reliably the real domain. Returns null if none
 * stands out — far better than fabricating `<slug>.com`, which is wrong for any
 * company whose domain differs from its YC slug (dyte.io, getbinks.com, …).
 */
export function extractYcWebsite(html: string): string | null {
  const $ = cheerio.load(html);
  const freq = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let u: URL;
    try { u = new URL(href); } catch { return; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    const host = u.host.replace(/^www\./, "");
    if (!host.includes(".") || NON_WEBSITE_HOST_RE.test(host)) return;
    freq.set(host, (freq.get(host) ?? 0) + 1);
  });
  let best: string | null = null;
  let bestN = 0;
  for (const [host, n] of freq) if (n > bestN) { best = host; bestN = n; }
  return best ? `https://${best}` : null;
}

async function resolveYcWebsite(ycSlug: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.ycombinator.com/companies/${ycSlug}`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return extractYcWebsite(await res.text());
  } catch {
    return null;
  }
}

// YC India directory scraper. The directory is a React SPA — Playwright
// renders, then cheerio walks the company cards.
export interface YcCandidate {
  name: string;
  careersUrl: string;
  source: "yc-india";
  evidence: string;
}

export interface YcResult {
  candidates: YcCandidate[];
  cardsSeen: number;
  errors: string[];
}

const COMPANY_LINK_RE = /^\/companies\/[a-z0-9-]+$/i;

// Matches the city-prefix in YC card text like "GrowwBengaluru, KA, India".
// Cities sorted longest-first so "New Delhi" matches before "Delhi".
function buildCityDelimiterRegex(): RegExp {
  const cities = [...profile.location.targetCities]
    .sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (cities.length === 0) return /a^/;
  return new RegExp(`^(.+?)(?:${cities.join("|")})\\b`, "i");
}
const CITY_DELIM_RE = buildCityDelimiterRegex();

export async function runYcSource(): Promise<YcResult> {
  const url = config.discovery.yc.directoryUrl;
  let page;
  try {
    page = await fetchHtmlPlaywright(url);
  } catch (err) {
    return { candidates: [], cardsSeen: 0, errors: [`yc fetch failed: ${String(err).slice(0, 160)}`] };
  }

  const $ = cheerio.load(page.html);
  // YC wraps each card in multiple anchors with the same href (link-overlays
  // + one with the visible text). Group by slug, keep the longest text.
  const bestText = new Map<string, string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!COMPANY_LINK_RE.test(href)) return;
    const ycSlug = href.replace(/^\/companies\//, "");
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const prev = bestText.get(ycSlug) ?? "";
    if (text.length > prev.length) bestText.set(ycSlug, text);
  });
  // Unique companies, not anchor elements — each card has 2-3 anchors.
  const cardsSeen = bestText.size;

  // Build the parsed-card list first (name + evidence + ycSlug), then resolve
  // each company's real website from its YC detail page.
  interface ParsedCard { ycSlug: string; name: string; evidence: string }
  const cards: ParsedCard[] = [];
  for (const [ycSlug, text] of bestText) {
    if (!text || text.length < 3 || text.length > 300) continue;

    // YC cards run "<Name><City>, <Region>, India<Tagline>" with no separators.
    // Use the first city as a delimiter — everything before it is the name.
    const m = CITY_DELIM_RE.exec(text);
    if (!m || !m[1]) continue;
    const name = m[1].trim();
    if (name.length < 2 || name.length > 80) continue;

    const batchMatch = text.match(/\b([WSF]\d{2})\b/);
    const evidence = batchMatch
      ? `YC ${batchMatch[1]} · ${text.slice(0, 140)}`
      : `YC India · ${text.slice(0, 140)}`;
    cards.push({ ycSlug, name, evidence });
  }

  // Resolve real websites concurrently. A card whose website can't be resolved
  // is dropped rather than seeded with a fabricated `<slug>.com/careers` guess —
  // that guess was wrong for most companies and produced dead/suspect entries.
  const out: YcCandidate[] = [];
  let unresolved = 0;
  let cursor = 0;
  const RESOLVE_CONCURRENCY = 6;
  async function worker(): Promise<void> {
    while (cursor < cards.length) {
      const card = cards[cursor++]!;
      const website = await resolveYcWebsite(card.ycSlug);
      if (!website) { unresolved++; continue; }
      out.push({ name: card.name, careersUrl: website, source: "yc-india", evidence: card.evidence });
    }
  }
  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, () => worker()));

  if (out.length > 0 || cardsSeen > 0) {
    logger.info({ candidates: out.length, cardsSeen, unresolved }, "yc: India directory scanned");
  }

  return { candidates: out, cardsSeen, errors: [] };
}
