// src/ats/spire2grow.ts — Spire2Grow careers boards (jobs.<company>.com shells
// backed by io.spire2grow.com). The API is unlocked by a single tenant header
// (no bearer token):
//   GET https://io.spire2grow.com/ies/v1/p/requisition/_search
//         ?page=<n>&size=<N>&selectedSortOrder=desc&selectedSortField=postedOn
//     header: workspaceid: <apiMeta.workspaceId, e.g. MYNTRA-93as3>
//     -> { entities: [{ id, displayId, jobTitle, jobLocation: [{city,state,
//          country,fqLocationName}], departmentName, jobDescription (HTML) }] }
// Verified live on Myntra (70 jobs, 2026-07-18). Paged by page/size.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep } from "./shared.js";

const SIZE = 100;
const MAX_PAGES = 100;

const LocSchema = z.object({
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  fqLocationName: z.string().nullable().optional(),
});
export const Spire2GrowJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  displayId: z.union([z.string(), z.number()]).nullable().optional(),
  jobTitle: z.string(),
  jobLocation: z.array(LocSchema).nullable().optional(),
  departmentName: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  createdOn: z.union([z.string(), z.number()]).nullable().optional(),
});
export type Spire2GrowJob = z.infer<typeof Spire2GrowJobSchema>;
export const Spire2GrowResponseSchema = z.object({ entities: z.array(Spire2GrowJobSchema).nullable().optional() });

function workspaceId(company: AdapterCompany): string {
  const w = company.apiMeta?.workspaceId;
  if (!w) throw new Error(`spire2grow requires apiMeta.workspaceId for ${company.slug}`);
  return w;
}

export function normalizeSpire2Grow(company: AdapterCompany, j: Spire2GrowJob): NormalizedPosting {
  const location =
    (j.jobLocation ?? [])
      .map((l) => l.fqLocationName ?? [l.city, l.state, l.country].filter(Boolean).join(", "))
      .filter(Boolean)
      .join("; ") || null;
  return {
    provider: "spire2grow",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle,
    jobUrl: (company.tenantUrl ?? company.careersUrl) + (j.displayId ? `#${j.displayId}` : ""),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.jobDescription ?? ""),
    postedAt: j.createdOn != null ? String(j.createdOn) : null,
  };
}

export const spire2growAdapter: AtsAdapter = {
  provider: "spire2grow",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const ws = workspaceId(company);
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://io.spire2grow.com/ies/v1/p/requisition/_search?page=${page}&size=${SIZE}&selectedSortOrder=desc&selectedSortField=postedOn`;
      const raw = await atsFetchJson(url, {
        provider: "spire2grow",
        userAgent: BROWSER_UA,
        headers: { workspaceid: ws },
      });
      const parsed = parseOrThrow(Spire2GrowResponseSchema, raw, {
        provider: "spire2grow",
        slug: company.slug,
        what: `list p${page}`,
      });
      const rows = parsed.entities ?? [];
      const before = out.length;
      for (const j of rows) {
        const p = normalizeSpire2Grow(company, j);
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      if (rows.length < SIZE || out.length === before) break;
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  },
};
