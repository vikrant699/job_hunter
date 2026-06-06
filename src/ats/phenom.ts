// src/ats/phenom.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const PAGE = 50;
const DELAY_MS = 150;

const JobSchema = z.object({
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
export type PhenomJob = z.infer<typeof JobSchema>;

/** Extract the `phApp.ddo = {...};` JSON island from a Phenom search page.
 * Anchored at the closing </script> so a literal `};` inside a string value
 * (e.g. a job teaser) can't truncate the blob; falls back to the lazy match. */
export function extractPhenomDdo(html: string): unknown | null {
  const m = html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
    ?? html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}

/** Pull jobs[] + totalHits from a parsed ddo (tolerant of both key shapes). */
export function phenomJobsFrom(ddo: unknown): { jobs: unknown[]; totalHits: number } {
  const d = ddo as Record<string, any> | null;
  const node = d?.eagerLoadRefineSearch ?? d?.refineSearch ?? {};
  const jobs = node?.data?.jobs ?? [];
  const totalHits = Number(node?.totalHits ?? node?.data?.counts?.totalHits ?? jobs.length ?? 0);
  return { jobs: Array.isArray(jobs) ? jobs : [], totalHits };
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
    jdText: htmlToText(j.descriptionTeaser ?? ""),
    postedAt: j.postedDate ?? j.dateCreated ?? null,
  };
}

export const phenomAdapter: AtsAdapter = {
  provider: "phenom",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) throw new Error(`phenom requires tenant_url (search URL) for ${company.slug}`);
    const out: NormalizedPosting[] = [];
    let from = 0;
    let total: number | null = null;
    for (let page = 0; ; page++) {
      const sep = company.tenantUrl.includes("?") ? "&" : "?";
      const url = `${company.tenantUrl}${sep}from=${from}&size=${PAGE}`;
      const html = await atsFetchText(url, { provider: "phenom" });
      const ddo = extractPhenomDdo(html);
      if (!ddo) {
        if (page === 0) throw new Error(`phenom: no phApp.ddo island for ${company.slug}`);
        break;
      }
      const { jobs, totalHits } = phenomJobsFrom(ddo);
      for (const raw of jobs) {
        const parsed = JobSchema.safeParse(raw);
        // Skip postings with no stable id — they'd collide on the
        // (provider, external_id) dedup key as empty strings.
        if (parsed.success && (parsed.data.jobId != null || parsed.data.reqId != null)) {
          out.push(normalizePhenom(company, parsed.data));
        }
      }
      if (total === null) total = totalHits;
      if (jobs.length === 0) break;
      from += jobs.length;          // advance by actual count (server may cap size)
      if (total && from >= total) break;
      if (page > 200) break;        // safety
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    return out;
  },
};
