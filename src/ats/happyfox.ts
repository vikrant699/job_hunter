// list: GET hiring.happyfox.co/api/jobs/?page=N&page_size=100 -> {results[{id,title,slug,location{name},work_type}], pagination{total_count,has_next}}; HappyFox's in-house board, no auth
// jd: GET hiring.happyfox.co/jobs/<slug>/ -> server-rendered, body in .job-description .prose (no JSON detail endpoint)
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { JsonValue } from "../util/json.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, collapseWs, paginate } from "./shared.js";

export const HAPPYFOX_ORIGIN = "https://hiring.happyfox.co";
const PAGE_SIZE = 100;

const HappyfoxJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  slug: z.string().min(1),
  location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  work_type: z.string().nullable().optional(),
});
type HappyfoxJob = z.infer<typeof HappyfoxJobSchema>;

const HappyfoxListSchema = z.object({
  results: z.array(HappyfoxJobSchema),
  pagination: z.object({ has_next: z.boolean() }),
});

// tenant_url wins; careers_url only when it is the board host itself (the registry's careers_url is happyfox.com/jobs)
export function happyfoxOrigin(company: AdapterCompany): string {
  for (const u of [company.tenantUrl, company.careersUrl]) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (url.hostname.startsWith("hiring.")) return url.origin;
    } catch {
      continue;
    }
  }
  return HAPPYFOX_ORIGIN;
}

export function happyfoxListUrl(origin: string, page: number): string {
  return `${origin}/api/jobs/?page=${page}&page_size=${PAGE_SIZE}`;
}

export function parseHappyfoxList(
  raw: JsonValue,
  company: AdapterCompany,
  origin: string,
): { postings: NormalizedPosting[]; hasNext: boolean } {
  const parsed = parseOrThrow(HappyfoxListSchema, raw, { provider: "happyfox", slug: company.slug });
  return {
    postings: parsed.results.map((j) => normalizeHappyfox(company, origin, j)),
    hasNext: parsed.pagination.has_next,
  };
}

function normalizeHappyfox(company: AdapterCompany, origin: string, j: HappyfoxJob): NormalizedPosting {
  const location = j.location?.name?.trim() || null;
  return {
    provider: "happyfox",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: collapseWs(j.title),
    jobUrl: `${origin}/jobs/${encodeURIComponent(j.slug)}/`,
    location,
    isRemote: j.work_type === "remote" || (location ? REMOTE_RE.test(location) : false),
    jdText: "",
    postedAt: null,
  };
}

export function parseHappyfoxJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".job-description .prose").first();
  const body = el.length ? el : $(".job-description").first();
  if (!body.length) return "";
  const inner = body.html();
  return inner ? htmlToText(inner) : collapseWs(body.text());
}

export const happyfoxAdapter: AtsAdapter = {
  provider: "happyfox",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = happyfoxOrigin(company);
    return paginate<NormalizedPosting>({
      provider: "happyfox",
      company: company.slug,
      pageSize: "infer",
      // has_next is the authority, so a page the server clamps below page_size must not read as the last one
      shortPageEndsPagination: false,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, page) => {
        const raw = await atsFetchJson(happyfoxListUrl(origin, page + 1), { provider: "happyfox" });
        const { postings, hasNext } = parseHappyfoxList(raw, company, origin);
        // has_next=false pins the total to the rows seen so far, ending the crawl without an extra empty fetch
        return { items: postings, total: hasNext ? null : offset + postings.length, rawCount: postings.length };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "happyfox" });
    return parseHappyfoxJd(html);
  },
};
