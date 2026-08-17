// src/ats/snapdeal.ts — Snapdeal careers, a single static WordPress page (id 632, slug "careers") listing every opening as one <p> per role starting "Title/Role: X"; applicants apply by emailing ta@snapdeal.com, so there's no per-job URL and jobUrl is the careers page itself for every posting.
// GET wp-json/wp/v2/pages/632; if the page id is ever renumbered, falls back to the site's search API for "open positions". Throws if neither resolves - never silently [].
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { kebabCase } from "../util/slug.js";

const ORIGIN = "https://blog.snapdeal.com/index.php";
const CAREERS_PAGE_ID = 632;
export const SNAPDEAL_CAREERS_URL = `${ORIGIN}/careers/`;
// The page states its entire board is for "our Gurugram office" and never names a location per-role, so this is a constant, not an extraction.
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

/** Pull every "Title/Role: ..." opening out of the page body; a paragraph without that marker is boilerplate (intro/footer copy) and is skipped, not mis-parsed as a job. */
export function parseSnapdealOpenings(contentHtml: string): SnapdealOpening[] {
  const openings: SnapdealOpening[] = [];
  for (const p of extractParagraphs(contentHtml)) {
    const text = htmlToText(p).trim();
    if (!TITLE_MARKER_RE.test(text)) continue;

    const firstLineEnd = text.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
    const title = firstLine.replace(TITLE_MARKER_RE, "").trim();
    if (!title) continue;

    // jdText is the whole block - the full JD Snapdeal makes available, nothing further to fetch.
    openings.push({ title, jdText: text });
  }
  return openings;
}

/** Kebab-case of the title; two openings with an identical title would collide on the (provider, externalId) dedup key, acceptable for a board this small and static. */
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

/** Fetch the careers page body: page 632 first, falling back to the site's search API only on a 404 (any other failure propagates as-is). Throws - never silently returns "". */
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
