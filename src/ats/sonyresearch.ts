// GET wp-json/wp/v2/pages?slug=careers; the NinjaFirewall WAF 403s the bot UA, so a browser UA is used. Title is the nearest PRECEDING <h2> (a "no open positions" heading always sits farther away).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";

const CAREERS_API = "https://www.sonyresearchindia.com/wp-json/wp/v2/pages?slug=careers";
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

function cleanBlockText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

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
    if (!heading || !heading.title) continue;

    const closeIdx = contentHtml.indexOf("</a>", linkIndex);
    const blockEnd = closeIdx === -1 ? linkIndex + jobUrl.length : closeIdx + 4;
    const block = contentHtml.slice(heading.index, blockEnd);
    const jdText = cleanBlockText(htmlToText(block));

    openings.push({ externalId, title: heading.title, jobUrl, jdText });
  }
  return openings;
}

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
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (posting.jdText) return posting.jdText;
    const html = await fetchSonyResearchCareersHtml();
    const openings = parseSonyResearchOpenings(html);
    const match = openings.find((o) => o.externalId === posting.externalId);
    return match?.jdText ?? "";
  },
};
