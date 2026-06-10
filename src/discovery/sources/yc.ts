import * as cheerio from "cheerio";
import { config } from "../../config.js";
import { profile } from "../../profile.js";
import { logger } from "../../logger.js";
import { fetchHtmlPlaywright } from "../../scraper/playwright.js";

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

  const out: YcCandidate[] = [];
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

    // Best-guess careers URL — the orchestrator probes and falls back to
    // llm-scrape if it doesn't resolve.
    const careersUrl = `https://${ycSlug}.com/careers`;

    out.push({ name, careersUrl, source: "yc-india", evidence });
  }

  if (out.length > 0) {
    logger.info({ candidates: out.length, cardsSeen }, "yc: India directory scanned");
  }

  return { candidates: out, cardsSeen, errors: [] };
}
