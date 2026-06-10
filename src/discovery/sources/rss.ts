import * as cheerio from "cheerio";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { fetchHtml } from "../../scraper/cheerio.js";

// Funding-announcement feeds. Companies that just raised money are usually
// actively hiring. We pull names from the headline + the company website
// from the article body.
export interface RssCandidate {
  name: string;
  /** Best-guess careers URL — defaults to `<website>/careers`. */
  careersUrl: string;
  source: "inc42-funding" | "yourstory-funding";
  evidence: string;
  /** Article pubDate, ISO. */
  publishedAt: string | null;
}

export interface RssResult {
  candidates: RssCandidate[];
  feedsFetched: number;
  articlesScanned: number;
  errors: string[];
}

// "Acme raises $5M", "Acme bags $2M", "Acme secures Series A".
const HEADLINE_VERB_RE = /\s+(raises?|bags?|secures?|nets?|closes?|locks?|mops?\s+up|brings?\s+in|garners?|picks?\s+up|gets?)\s+/i;

// Pull a company name from a funding-announcement title. Strips prefixes
// like "[Funding alert]", "[Update]", emoji markers, city-based descriptors.
function extractCompanyName(title: string): string | null {
  let t = title.trim();
  // Strip leading bracketed tags
  t = t.replace(/^[\[\(][^\]\)]+[\]\)]\s*/g, "").trim();
  t = t.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*/u, "").trim();
  t = t.replace(/^(funding\s*alert\s*:?|funding\s*:|exclusive\s*:|update\s*:)\s*/i, "").trim();
  const m = HEADLINE_VERB_RE.exec(t);
  if (m && m.index > 0) {
    t = t.slice(0, m.index).trim();
  } else {
    return null;
  }
  t = t.replace(/[,;:.\-—–]+$/, "").trim();
  if (t.length < 2 || t.length > 80) return null;
  t = t.replace(/^(india(n)?|bengaluru|bangalore|mumbai|delhi|pune|chennai|hyderabad|gurgaon|gurugram|noida)[-\s]+based\s+/i, "");
  // Strip industry descriptor + type-noun prefix: "Biotech Startup Cellogen…",
  // "D2C Toymaker Legend Of Toys" — keep the trailing capitalised name.
  const trailing = t.match(/\b(?:startup|company|firm|platform|brand|maker|toymaker|provider|developer|publisher|services?|solutions?|app|venture)\s+((?:[A-Z][\w&\-.]*(?:\s+(?:[A-Z][\w&\-.]*|of|and|the)){0,2}))\s*$/i);
  if (trailing && trailing[1]) {
    t = trailing[1].trim();
  }
  if (t.length < 2 || t.length > 80) return null;
  return t.trim() || null;
}

function isRecent(pubDate: string | null): boolean {
  if (!pubDate) return true;  // be permissive when no date
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return true;
  const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= config.discovery.rssMaxArticleAgeDays;
}

// Find an outbound link in the article body that matches the company name.
async function findCompanyWebsite(articleUrl: string, companyName: string): Promise<string | null> {
  let publisherHost: string;
  try { publisherHost = new URL(articleUrl).host; } catch { return null; }

  let html;
  try {
    const fetched = await fetchHtml(articleUrl);
    html = fetched.html;
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  const nameLower = companyName.toLowerCase();
  const tokens = nameLower.split(/\s+/).filter((s) => s.length > 2);
  let bestUrl: string | null = null;

  $("a[href]").each((_, el) => {
    if (bestUrl) return;
    const href = $(el).attr("href");
    if (!href) return;
    let abs: URL;
    try { abs = new URL(href, articleUrl); } catch { return; }
    if (abs.host === publisherHost) return;
    if (abs.host === "twitter.com" || abs.host === "x.com" || abs.host === "linkedin.com"
        || abs.host === "facebook.com" || abs.host === "instagram.com"
        || abs.host === "youtube.com" || abs.host.endsWith(".gov.in")
        || abs.host === "wikipedia.org" || abs.host.endsWith(".wikipedia.org")) {
      return;
    }
    const text = $(el).text().trim().toLowerCase();
    const hostLower = abs.host.toLowerCase().replace(/^www\./, "");
    const anchorMatchesName = tokens.some((t) => text.includes(t)) || text === nameLower;
    const hostMatchesName = tokens.some((t) => hostLower.includes(t));
    if (anchorMatchesName || hostMatchesName) {
      bestUrl = `${abs.protocol}//${abs.host}`;
    }
  });
  return bestUrl;
}

async function fetchRssFeed(url: string): Promise<Array<{ title: string; link: string; pubDate: string | null }>> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": config.fetch.userAgent,
    },
    // A stalled feed must not hang the whole discovery loop.
    signal: AbortSignal.timeout(config.fetch.timeoutMs),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status} fetching ${url}`);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const items: Array<{ title: string; link: string; pubDate: string | null }> = [];
  $("item").each((_, el) => {
    const title = $(el).find("title").first().text().trim();
    const link = $(el).find("link").first().text().trim();
    const pubDate = $(el).find("pubDate").first().text().trim() || null;
    if (title && link) items.push({ title, link, pubDate });
  });
  return items;
}

export async function runRssSources(): Promise<RssResult> {
  const out: RssCandidate[] = [];
  const errors: string[] = [];
  let feedsFetched = 0;
  let articlesScanned = 0;

  for (const feed of config.discovery.rss.sources) {
    let items;
    try {
      items = await fetchRssFeed(feed.url);
      feedsFetched++;
    } catch (err) {
      errors.push(`${feed.name}: ${String(err).slice(0, 160)}`);
      continue;
    }

    for (const item of items) {
      articlesScanned++;
      if (!isRecent(item.pubDate)) continue;
      const name = extractCompanyName(item.title);
      if (!name) continue;

      // Try to find the company's website in the article.
      const websiteRoot = await findCompanyWebsite(item.link, name);
      const careersUrl = websiteRoot
        ? `${websiteRoot}/careers`
        // Fallback: derive a careers URL guess from the company name
        // (this is rough but the discovery validator will probe it anyway).
        : `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com/careers`;

      // skip results that look like they pulled the publisher domain
      try {
        const careersHost = new URL(careersUrl).host;
        const articleHost = new URL(item.link).host;
        if (careersHost === articleHost) continue;
      } catch { continue; }

      const source: "inc42-funding" | "yourstory-funding" =
        feed.name === "inc42-funding" ? "inc42-funding" : "yourstory-funding";
      out.push({
        name,
        careersUrl,
        source,
        evidence: `${feed.name}: ${item.title.slice(0, 120)}`,
        publishedAt: item.pubDate,
      });
    }

    // Per-feed log — an earlier feed's error must not silence this one's.
    logger.info({ source: feed.name, items: items.length, candidates: out.length }, "rss: feed scanned");
  }

  return { candidates: out, feedsFetched, articlesScanned, errors };
}
