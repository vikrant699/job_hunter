// src/ats/sonyresearch.ts — Sony Research India careers
// (sonyresearchindia.com), a single static WordPress/Elementor page whose
// job-openings section renders each opening as an <h2> title, a text-editor
// block with "Location:"/"Duration:" lines, and an "Apply Now" button linking
// to a LinkedIn job posting (linkedin.com/jobs/view/<id>/) — LinkedIn IS the
// application channel here, there is no separate ATS.
//
// Confirmed live 2026-07-12:
//   GET https://www.sonyresearchindia.com/wp-json/wp/v2/pages?slug=careers
// -> array with one page; content.rendered (~140KB Elementor HTML) has 3
// linkedin.com/jobs/view links today (Multimodal AI Intern, Machine Learning
// Consultant, LLM Engineer). The site's NinjaFirewall WAF 403s the plain bot
// UA, so (like Jibe) this fetch goes out with a browser UA.
//
// Each opening's title is the nearest PRECEDING <h2> heading before its Apply
// link. Elementor also renders a "Thank you... no open positions" placeholder
// <h2> per category — but it always sits FARTHER from the Apply link than the
// real title heading, so "nearest preceding" resolves to the right one.
//
// jdText is the htmlToText of the whole span from that <h2> through the
// closing </a> of the Apply link — this is genuinely all the copy Sony
// publishes per opening (title + Location + Duration); nothing more to fetch.
// fetchJd never reaches out to LinkedIn — it re-derives the same page text.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

const CAREERS_API = "https://www.sonyresearchindia.com/wp-json/wp/v2/pages?slug=careers";
// Every opening seen live names Bengaluru explicitly in its own "Location:"
// line; this is only the fallback for the (so far hypothetical) case a
// future opening omits it.
export const SONYRESEARCH_DEFAULT_LOCATION = "Bengaluru, India";

const WpPageSchema = z.object({
  content: z.object({ rendered: z.string() }),
});
const WpPageListSchema = z.array(WpPageSchema);

export interface SonyResearchOpening {
  externalId: string;
  title: string;
  jobUrl: string;
  jdText: string;
}

const H2_RE = /<h2[^>]*>([^<]*)<\/h2>/gi;
const LINK_RE = /href="(https:\/\/www\.linkedin\.com\/jobs\/view\/(\d+)\/?)"/gi;

/** Drop blank/whitespace-only lines a run of empty Elementor divs leaves behind. */
function cleanBlockText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Pull every LinkedIn "Apply Now" opening out of the careers page body.
 * Associates each link with the nearest PRECEDING <h2> heading, and takes the
 * text from that heading through the link's closing </a> as the opening's
 * whole published blurb. Returns [] when the page has no such links at all
 * (genuinely zero openings, not an error).
 */
export function parseSonyResearchOpenings(contentHtml: string): SonyResearchOpening[] {
  const headings: { index: number; title: string }[] = [];
  H2_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = H2_RE.exec(contentHtml)) !== null) {
    headings.push({ index: hm.index, title: htmlToText(hm[1] ?? "").trim() });
  }

  const openings: SonyResearchOpening[] = [];
  LINK_RE.lastIndex = 0;
  let lm: RegExpExecArray | null;
  while ((lm = LINK_RE.exec(contentHtml)) !== null) {
    const linkIndex = lm.index;
    const jobUrl = lm[1] ?? "";
    const externalId = lm[2] ?? "";
    if (!jobUrl || !externalId) continue;

    let heading: { index: number; title: string } | null = null;
    for (const h of headings) {
      if (h.index < linkIndex) heading = h;
      else break;
    }
    // No heading precedes this link at all — can't name the opening; skip
    // rather than emit a titleless posting.
    if (!heading || !heading.title) continue;

    const closeIdx = contentHtml.indexOf("</a>", linkIndex);
    const blockEnd = closeIdx === -1 ? linkIndex + jobUrl.length : closeIdx + 4;
    const block = contentHtml.slice(heading.index, blockEnd);
    const jdText = cleanBlockText(htmlToText(block));

    openings.push({ externalId, title: heading.title, jobUrl, jdText });
  }
  return openings;
}

/** "Location:" label out of the block text, falling back to the constant default. */
export function sonyResearchLocation(jdText: string): string {
  const m = /location\s*:\s*([^\n]+)/i.exec(jdText);
  const found = m?.[1]?.trim();
  return found || SONYRESEARCH_DEFAULT_LOCATION;
}

export function normalizeSonyResearchOpening(company: AdapterCompany, o: SonyResearchOpening): NormalizedPosting {
  const location = sonyResearchLocation(o.jdText);
  return {
    provider: "sonyresearch",
    externalId: o.externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: o.title,
    jobUrl: o.jobUrl,
    location,
    isRemote: REMOTE_RE.test(location),
    jdText: o.jdText,
    postedAt: null,
  };
}

async function fetchSonyResearchCareersHtml(): Promise<string> {
  const raw = await atsFetchJson(CAREERS_API, { provider: "sonyresearch", userAgent: BROWSER_UA });
  const pages = WpPageListSchema.parse(raw);
  const page = pages[0];
  if (!page) throw new Error("sonyresearch: careers page not found (slug=careers returned no pages)");
  return page.content.rendered;
}

export const sonyresearchAdapter: AtsAdapter = {
  provider: "sonyresearch",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await fetchSonyResearchCareersHtml();
    const openings = parseSonyResearchOpenings(html);
    return openings.map((o) => normalizeSonyResearchOpening(company, o));
  },
  // jdText is already fully populated inline above. fetchJd exists only as a
  // defensive fallback for a future opening whose in-page blurb is empty (or
  // for a caller that invokes it anyway) — it re-derives the SAME page
  // section text and never fetches LinkedIn.
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (posting.jdText) return posting.jdText;
    const html = await fetchSonyResearchCareersHtml();
    const openings = parseSonyResearchOpenings(html);
    const match = openings.find((o) => o.externalId === posting.externalId);
    return match?.jdText ?? "";
  },
};
