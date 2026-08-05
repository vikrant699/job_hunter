// src/ats/snapdeal.ts — Snapdeal careers (blog.snapdeal.com), a single static
// WordPress page (id 632, slug "careers") whose body lists every opening as
// one <p> per role: "Title/Role: X", "Skill Set (Area of Expertise): Y",
// "Experience: Z". There is no per-job API and no per-job URL — applicants
// are told to email ta@snapdeal.com with the job title in the subject line,
// so jobUrl for every posting is the careers page itself.
//
// Confirmed live 2026-07-12:
//   GET https://blog.snapdeal.com/index.php/wp-json/wp/v2/pages/632
// -> WP page JSON; content.rendered (~5.5KB HTML) has exactly one <p> per
// opening (25 openings today), each starting with a "Title/Role:" line —
// intro copy and the closing "email us" paragraphs are plain <p>s with no
// such marker, so filtering paragraphs on that marker cleanly separates jobs
// from boilerplate without needing to split mid-paragraph.
//
// Page id 632 is hardcoded (this is a single-company, single-page board) but
// resolved defensively: if it ever 404s (page renumbered/removed), fall back
// to the site's own search API for "open positions" and use whatever page id
// that turns up instead. Throws if neither resolves — never silently [].
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { kebabCase } from "../util/slug.js";

const ORIGIN = "https://blog.snapdeal.com/index.php";
const CAREERS_PAGE_ID = 632;
// The page itself is what applicants are told to read/apply from — there is
// no per-job page, so every posting's jobUrl points here.
export const SNAPDEAL_CAREERS_URL = `${ORIGIN}/careers/`;
// The page states its entire board is for "our Gurugram office" and never
// names a location per-role — so this is a constant, not an extraction.
export const SNAPDEAL_LOCATION = "Gurugram, India";

const WpPageSchema = z.object({
  content: z.object({ rendered: z.string() }),
});

const SearchHitSchema = z.object({
  id: z.union([z.string(), z.number()]),
  subtype: z.string().nullable().optional(),
});
const SearchResultsSchema = z.array(SearchHitSchema);

export interface SnapdealOpening {
  title: string;
  jdText: string;
}

const TITLE_MARKER_RE = /title\s*\/\s*role\s*:/i;

/** Inner HTML of every top-level <p>...</p> paragraph in the page body. */
function extractParagraphs(html: string): string[] {
  const out: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? "");
  return out;
}

/**
 * Pull every "Title/Role: ..." opening out of the careers page body. Live
 * verified: the page publishes exactly one opening per <p> — a paragraph
 * that doesn't mention "Title/Role:" is boilerplate (intro copy, the "email
 * us" footer, the culture blurb) and is skipped rather than mis-parsed as a
 * job. Returns [] when the page genuinely has no such blocks (not an error —
 * distinct from the page being unreachable, which throws upstream).
 */
export function parseSnapdealOpenings(contentHtml: string): SnapdealOpening[] {
  const openings: SnapdealOpening[] = [];
  for (const p of extractParagraphs(contentHtml)) {
    const text = htmlToText(p).trim();
    if (!TITLE_MARKER_RE.test(text)) continue;

    const firstLineEnd = text.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
    const title = firstLine.replace(TITLE_MARKER_RE, "").trim();
    if (!title) continue;

    // jdText is the ENTIRE block (title line + skill set + experience +
    // anything else the page publishes for this role) — this is the full JD
    // Snapdeal makes available, there is nothing further to fetch.
    openings.push({ title, jdText: text });
  }
  return openings;
}

/**
 * Stable-enough id for this small, hand-maintained list: kebab-case of the
 * title. Two openings with the exact identical title (none today, live
 * verified 25 distinct titles) would collide on the (provider, externalId)
 * dedup key — acceptable for a board this size and static in nature; called
 * out here rather than silently risked.
 */
export function snapdealExternalId(title: string): string {
  return kebabCase(title);
}

export function normalizeSnapdealOpening(company: AdapterCompany, o: SnapdealOpening): NormalizedPosting {
  return {
    provider: "snapdeal",
    externalId: snapdealExternalId(o.title),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: o.title,
    jobUrl: SNAPDEAL_CAREERS_URL,
    location: SNAPDEAL_LOCATION,
    isRemote: false,
    jdText: o.jdText,
    postedAt: null,
  };
}

async function fetchSnapdealPageContent(pageId: number): Promise<string> {
  const raw = await atsFetchJson(`${ORIGIN}/wp-json/wp/v2/pages/${pageId}`, { provider: "snapdeal" });
  return WpPageSchema.parse(raw).content.rendered;
}

/**
 * Fetch the careers page body, resolving its id defensively: page 632 first;
 * if (and only if) that 404s, fall back to the site's own search API for
 * "open positions" and use the first page-type hit's id instead. Any other
 * failure (network error, unexpected shape) propagates as-is rather than
 * being masked by a fallback attempt. Throws — never silently returns "".
 */
export async function fetchSnapdealCareersHtml(): Promise<string> {
  try {
    return await fetchSnapdealPageContent(CAREERS_PAGE_ID);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "snapdeal 404") throw err;
    logger.warn({ pageId: CAREERS_PAGE_ID }, "snapdeal: careers page 404 — trying search fallback");
  }

  const searchRaw = await atsFetchJson(
    `${ORIGIN}/wp-json/wp/v2/search?search=open%20positions&per_page=5`,
    { provider: "snapdeal" },
  );
  const hits = SearchResultsSchema.parse(searchRaw);
  const pageHit = hits.find((h) => h.subtype === "page");
  if (!pageHit) throw new Error("snapdeal: careers page not found (632 gone, no fallback match)");

  return fetchSnapdealPageContent(Number(pageHit.id));
}

export const snapdealAdapter: AtsAdapter = {
  provider: "snapdeal",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await fetchSnapdealCareersHtml();
    const openings = parseSnapdealOpenings(html);
    return openings.map((o) => normalizeSnapdealOpening(company, o));
  },
  // The list page already carries the full JD text inline — no fetchJd needed.
};
