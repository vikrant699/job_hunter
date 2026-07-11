// src/ats/phenom.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, getObj, type JsonValue } from "../util/json.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 50;

export const PhenomJobSchema = z.object({
  jobId: z.union([z.string(), z.number()]).nullable().optional(),
  reqId: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string(),
  cityStateCountry: z.string().nullable().optional(),
  cityState: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  postedDate: z.string().nullable().optional(),
  dateCreated: z.string().nullable().optional(),
  descriptionTeaser: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
});
export type PhenomJob = z.infer<typeof PhenomJobSchema>;

/** Extract the `phApp.ddo = {...};` JSON island from a Phenom search page.
 * Anchored at the closing </script> so a literal `};` inside a string value
 * (e.g. a job teaser) can't truncate the blob; falls back to the lazy match. */
export function extractPhenomDdo(html: string): unknown | null {
  const m = html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
    ?? html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}

/** Canonical Phenom job page for one posting: `<origin>/<locale>/job/<jobId>`.
 * The locale prefix is the first two path segments of the tenant's search URL
 * (/us/en, /global/en, /in/en, ...). This page is server-rendered with its own
 * phApp.ddo island carrying the FULL description — the search ddo only has a
 * ~300-char descriptionTeaser. */
export function phenomJobPageUrl(tenantUrl: string, jobId: string): string {
  const u = new URL(tenantUrl);
  const segs = u.pathname.split("/").filter(Boolean);
  const locale = segs.slice(0, 2).join("/");
  return `${u.protocol}//${u.host}/${locale ? `${locale}/` : ""}job/${encodeURIComponent(jobId)}`;
}

/** Full JD from a job page's ddo: `jobDetail.data.job.description`. */
export function phenomJobDescriptionFrom(ddo: unknown): string | null {
  const parseResult = JsonValueSchema.safeParse(ddo);
  const d: JsonValue | null = parseResult.success ? parseResult.data : null;
  const job = getObj(getObj(getObj(d, "jobDetail"), "data"), "job");
  const description = job?.["description"];
  return typeof description === "string" && description.length > 0 ? description : null;
}

/** Pull jobs[] + totalHits from a parsed ddo (tolerant of both key shapes). */
export function phenomJobsFrom(ddo: unknown): { jobs: unknown[]; totalHits: number } {
  const parseResult = JsonValueSchema.safeParse(ddo);
  const d: JsonValue | null = parseResult.success ? parseResult.data : null;
  const nodeObj = getObj(d, "eagerLoadRefineSearch") ?? getObj(d, "refineSearch");
  const nodeData = getObj(nodeObj, "data");
  const jobs = nodeData?.["jobs"];
  const jobsArr = Array.isArray(jobs) ? jobs : [];
  const nodeCounts = getObj(nodeData, "counts");
  const totalHits = Number(nodeObj?.["totalHits"] ?? nodeCounts?.["totalHits"] ?? jobsArr.length);
  return { jobs: jobsArr, totalHits };
}

export function normalizePhenom(company: AdapterCompany, j: PhenomJob): NormalizedPosting {
  const location = j.cityStateCountry ?? j.cityState ?? j.location ?? null;
  return {
    provider: "phenom",
    externalId: String(j.jobId ?? j.reqId ?? ""),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.applyUrl ?? company.tenantUrl ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    // Left empty on purpose: the search ddo only carries a ~300-char teaser,
    // which starved the relevance gate. fetchJd pulls the full JD from the
    // posting's canonical job page instead.
    jdText: "",
    postedAt: j.postedDate ?? j.dateCreated ?? null,
  };
}

export const phenomAdapter: AtsAdapter = {
  provider: "phenom",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) throw new Error(`phenom requires tenant_url (search URL) for ${company.slug}`);
    const tenantUrl = company.tenantUrl;

    return paginate<NormalizedPosting>({
      provider: "phenom",
      company: company.slug,
      pageSize: PAGE,
      // The server may cap a page below `size` without that meaning "last
      // page" — only a zero-item page or reaching `totalHits` ends pagination.
      shortPageEndsPagination: false,
      fetchPage: async (from, page) => {
        const sep = tenantUrl.includes("?") ? "&" : "?";
        const url = `${tenantUrl}${sep}from=${from}&size=${PAGE}`;
        const html = await atsFetchText(url, { provider: "phenom" });
        const ddo = extractPhenomDdo(html);
        if (!ddo) {
          if (page === 0) throw new Error(`phenom: no phApp.ddo island for ${company.slug}`);
          return { items: [], total: null };
        }
        const { jobs, totalHits } = phenomJobsFrom(ddo);
        const items: NormalizedPosting[] = [];
        for (const raw of jobs) {
          const parsed = PhenomJobSchema.safeParse(raw);
          // Skip postings with no stable id — they'd collide on the
          // (provider, external_id) dedup key as empty strings.
          if (parsed.success && (parsed.data.jobId != null || parsed.data.reqId != null)) {
            items.push(normalizePhenom(company, parsed.data));
          }
        }
        return { items, total: totalHits, rawCount: jobs.length };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (!company.tenantUrl) throw new Error(`phenom requires tenant_url (search URL) for ${company.slug}`);
    const url = phenomJobPageUrl(company.tenantUrl, posting.externalId);
    const html = await atsFetchText(url, { provider: "phenom" });
    const ddo = extractPhenomDdo(html);
    const description = phenomJobDescriptionFrom(ddo);
    if (description === null) {
      throw new Error(`phenom: no jobDetail description at ${url} for ${company.slug}`);
    }
    return htmlToText(description);
  },
};
