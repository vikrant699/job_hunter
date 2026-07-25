// src/ats/eightfoldpcs.ts — Eightfold "PCSX" career-site JSON API, used by
// large enterprises on their OWN careers host (e.g. careers.qualcomm.com,
// apply.careers.microsoft.com). Distinct from src/ats/eightfold.ts, which
// targets the shared *.eightfold.ai tenant hosts and the /api/apply/v2/jobs
// API — PCSX tenants live on custom domains with no shared host signature.
//
//   list:   GET <host>/api/pcsx/search?domain=&query=&location=&start=&num=&sort_by=relevance
//             -> { data: { positions[], count } }
//   detail: GET <host>/api/pcsx/position_details?position_id=&domain=&hl=en
//             -> { data: { jobDescription, ... } }
//
// host lives in tenant_url, jobs domain in apiMeta.domain, optional
// apiMeta.location narrows server-side. Page size is server-fixed at 10 —
// the `num` param is accepted but ignored (verified live against Qualcomm),
// same as Jibe. Two-phase: job_description is absent from the list response.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, unixToIso, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

const PAGE = 10; // server-fixed; the num= param is ignored

const PositionSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  locations: z.array(z.string()).nullable().optional(),
  standardizedLocations: z.array(z.string()).nullable().optional(),
  postedTs: z.number().nullable().optional(),
  creationTs: z.number().nullable().optional(),
  workLocationOption: z.string().nullable().optional(),
  positionUrl: z.string().nullable().optional(),
});
export type EightfoldPcsPosition = z.infer<typeof PositionSchema>;

const SearchResponseSchema = z.object({
  data: z.object({
    positions: z.array(PositionSchema),
    count: z.number().nullable().optional(),
  }),
});

const DetailSchema = z.object({
  data: z.object({
    jobDescription: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    publicUrl: z.string().nullable().optional(),
    workLocationOption: z.string().nullable().optional(),
  }),
});

function hostOf(company: AdapterCompany): string {
  if (!company.tenantUrl) throw new Error(`eightfoldpcs requires tenant_url (host) for ${company.slug}`);
  return new URL(company.tenantUrl).origin;
}
function domainOf(company: AdapterCompany): string {
  const d = company.apiMeta?.domain;
  if (!d) throw new Error(`eightfoldpcs requires apiMeta.domain for ${company.slug}`);
  return d;
}

/** Paged search URL; `apiMeta.location` (e.g. "India") narrows server-side. */
export function eightfoldPcsSearchUrl(company: AdapterCompany, start: number): string {
  const host = hostOf(company);
  const domain = domainOf(company);
  const location = company.apiMeta?.location ?? "";
  return `${host}/api/pcsx/search?domain=${encodeURIComponent(domain)}&query=&location=${encodeURIComponent(location)}&start=${start}&num=${PAGE}&sort_by=relevance&triggerGoButton=false`;
}

export function eightfoldPcsDetailsUrl(company: AdapterCompany, positionId: string): string {
  const host = hostOf(company);
  const domain = domainOf(company);
  return `${host}/api/pcsx/position_details?position_id=${encodeURIComponent(positionId)}&domain=${encodeURIComponent(domain)}&hl=en`;
}

/** Unwrap the `data.{positions,count}` envelope. */
export function eightfoldPcsPageJobs(pageJson: unknown): { positions: EightfoldPcsPosition[]; count: number | null } {
  const parsed = SearchResponseSchema.parse(pageJson);
  return { positions: parsed.data.positions, count: parsed.data.count ?? null };
}

export function normalizeEightfoldPcs(company: AdapterCompany, p: EightfoldPcsPosition): NormalizedPosting {
  const location = (p.locations && p.locations[0]) ?? (p.standardizedLocations && p.standardizedLocations[0]) ?? null;
  return {
    provider: "eightfoldpcs",
    externalId: String(p.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.name,
    jobUrl: p.positionUrl ? `${hostOf(company)}${p.positionUrl}` : `${hostOf(company)}/careers/job/${p.id}`,
    location,
    isRemote: REMOTE_RE.test(`${p.workLocationOption ?? ""} ${location ?? ""}`),
    jdText: "", // absent from the list response; populated by fetchJd
    postedAt: unixToIso(p.postedTs ?? p.creationTs),
  };
}

export const eightfoldPcsAdapter: AtsAdapter = {
  provider: "eightfoldpcs",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "eightfoldpcs",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (start) => {
        const raw = await atsFetchJson(eightfoldPcsSearchUrl(company, start), {
          provider: "eightfoldpcs",
          userAgent: BROWSER_UA,
        });
        const parsed = parseOrThrow(SearchResponseSchema, raw, { provider: "eightfoldpcs", slug: company.slug });
        const { positions, count } = parsed.data;
        return {
          items: positions.map((p) => normalizeEightfoldPcs(company, p)),
          total: count ?? null,
          rawCount: positions.length,
        };
      },
    });
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(eightfoldPcsDetailsUrl(company, posting.externalId), {
      provider: "eightfoldpcs",
      userAgent: BROWSER_UA,
    });
    const parsed = parseOrNull(DetailSchema, raw, { provider: "eightfoldpcs", slug: company.slug, what: "detail" });
    if (!parsed) return "";
    return htmlToText(parsed.data.jobDescription ?? "");
  },
};
