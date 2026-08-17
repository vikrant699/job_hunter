import * as cheerio from "cheerio";
import { config } from "../config.js";
import { BROWSER_UA } from "../util/userAgent.js";

export interface FetchedHtml {
  finalUrl: string;
  html: string;
}

// Fetch with a browser UA + follow-redirects so we land on the real page.
export async function fetchHtml(url: string): Promise<FetchedHtml> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(config.fetch.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const html = await res.text();
  return { finalUrl: res.url || url, html };
}

export interface CandidateLink {
  url: string;
  text: string;
}

const JOB_URL_RE = /\/(jobs?|careers?|positions?|openings?|opportunit|apply|posting|listings?|hiring|roles?|vacanc)\b/i;
export const ROLE_TEXT_RE = /\b(analyst|engineer|manager|developer|designer|specialist|lead|director|associate|intern(?:ship)?|consultant|scientist|architect|coordinator|administrator|representative|executive|officer|head\b|principal|staff)\b/i;

/** Same-origin link shortlist (URL-shape OR text-shape match) from a careers page; downstream LLM picks the real postings. */
export function extractLinkShortlist(html: string, baseUrl: string): CandidateLink[] {
  const $ = cheerio.load(html);
  const out: CandidateLink[] = [];
  const seen = new Set<string>();

  let basePage: URL;
  try {
    basePage = new URL(baseUrl);
  } catch {
    return out;
  }

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const text = $(el).text().trim().replace(/\s+/g, " ");
    if (!text || text.length < 3 || text.length > 200) return;

    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      return;
    }

    // Same origin only (allow www.<host> ↔ <host> via host trim).
    const normalizeHost = (h: string) => h.replace(/^www\./, "");
    if (normalizeHost(abs.host) !== normalizeHost(basePage.host)) return;

    const absStr = abs.toString().split("#")[0];
    if (!absStr || seen.has(absStr)) return;

    const pathAndQuery = (abs.pathname + abs.search).toLowerCase();
    const isJobUrl = JOB_URL_RE.test(pathAndQuery);
    const isJobText = ROLE_TEXT_RE.test(text);
    if (!isJobUrl && !isJobText) return;

    // Exclude the careers index page itself (often matches both heuristics).
    if (abs.pathname.replace(/\/$/, "") === basePage.pathname.replace(/\/$/, "")) return;

    seen.add(absStr);
    out.push({ url: absStr, text });
  });

  return out;
}

/** Looks for an "actual openings" link when the top-level careers page is a marketing landing with a "View all jobs"-style CTA. Same-origin only. */
export function findOpeningsRecursionLink(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  let basePage: URL;
  try { basePage = new URL(baseUrl); } catch { return null; }

  const normalizeHost = (h: string) => h.replace(/^www\./, "");
  const baseHost = normalizeHost(basePage.host);

  // Patterns ordered roughly by strength of signal.
  const TEXT_PATTERNS = [
    /^(current|all|open|live)\s+(openings?|roles?|positions?|jobs?)/i,
    /^(view|browse|see|explore)\s+(all\s+)?(jobs?|roles?|openings?|positions?|opportunities)/i,
    /^(join\s+(us|the\s+team)|work\s+with\s+us)/i,
    /^(see|view)\s+open\s+(roles?|positions?|jobs?)/i,
    /^(check\s+out|find)\s+(our\s+)?(open\s+)?(jobs?|roles?|positions?|openings?)/i,
  ];
  const URL_PATTERNS = [
    /\/(careers?\/)?(open[-_]?)?positions?(\/|$)/i,
    /\/(careers?\/)?(open[-_]?)?roles?(\/|$)/i,
    /\/(careers?\/)?openings?(\/|$)/i,
    /\/(careers?\/)?(jobs?[-_]?)(listing|listings|openings|search)(\/|$)/i,
    /\/(careers?\/)?job[-_]?openings?(\/|$)/i,
    /\/(careers?\/)?all[-_]?(jobs?|roles?|openings?)(\/|$)/i,
    /\/(jobs?|join[-_]?us)(\/|$)/i,
  ];

  let bestUrl: string | null = null;
  let bestScore = 0;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().trim().replace(/\s+/g, " ");
    let abs: URL;
    try { abs = new URL(href, baseUrl); } catch { return; }
    if (normalizeHost(abs.host) !== baseHost) return;

    const path = (abs.pathname + abs.search).toLowerCase();
    // Don't recurse into the same page (would loop)
    if (abs.pathname.replace(/\/$/, "") === basePage.pathname.replace(/\/$/, "")) return;

    let score = 0;
    for (const re of TEXT_PATTERNS) {
      if (re.test(text)) { score += 3; break; }
    }
    for (const re of URL_PATTERNS) {
      if (re.test(path)) { score += 2; break; }
    }
    if (score > bestScore) {
      bestScore = score;
      bestUrl = abs.toString().split("#")[0] ?? abs.toString();
    }
  });

  // Require at least a text OR URL match (score >= 2), otherwise we might follow a random nav link.
  return bestScore >= 2 ? bestUrl : null;
}

/** Best-guess job title from a JD page: first <h1> under main, then <title>. */
export function extractTitleHint(html: string): string | null {
  const $ = cheerio.load(html);
  const mainH1 = $("main h1, [role='main'] h1").first().text().trim();
  const h1 = mainH1 || $("h1").first().text().trim();
  if (h1 && h1.length >= 3 && h1.length <= 200) {
    return h1.replace(/\s+/g, " ");
  }
  const t = $("title").first().text().trim();
  if (!t) return null;
  // "Foo Careers - (Director - Sales)" → "Director - Sales"
  const paren = t.match(/\(([^)]+)\)\s*$/);
  if (paren && paren[1]) return paren[1].trim();
  // "Director - Sales | Foo Careers" → "Director - Sales"
  const pipe = t.split(/\s*[|·•–—]\s*/)[0];
  if (pipe && pipe.length >= 3 && pipe.length <= 200) return pipe.trim();
  return t.replace(/\s+/g, " ").slice(0, 200);
}

/** Strip chrome (nav/header/footer/script) and return the page's main text. */
export function extractMainText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, form, iframe").remove();

  const main = $("main, [role='main']").first();
  const root = main.length ? main : $("body");

  // Replace <br> and block-closers with newlines so paragraphs stay separated.
  root.find("br").replaceWith("\n");

  const text = root.text();
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
