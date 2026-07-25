// src/ats/eightfold.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, unixToIso, paginate } from "./shared.js";

// Eightfold public API:
//   list:   GET <host>/api/apply/v2/jobs?domain=<domain>&start=&num=   -> {positions[],count}
//   detail: GET <host>/api/apply/v2/jobs/<id>?domain=<domain>          -> position w/ job_description
// host stored in tenant_url, jobs domain in api_meta.domain. Two-phase
// (job_description is empty in the list response).
const PositionSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  location: z.string().nullable().optional(),
  locations: z.array(z.string()).nullable().optional(),
  t_create: z.number().nullable().optional(),
  canonicalPositionUrl: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
});
type Position = z.infer<typeof PositionSchema>;
const ListSchema = z.object({ positions: z.array(PositionSchema), count: z.number().nullable().optional() });
const DetailSchema = z.object({
  positions: z.array(PositionSchema).nullable().optional(),
  job_description: z.string().nullable().optional(),
});

const PAGE = 50;

function hostOf(company: AdapterCompany): string {
  if (!company.tenantUrl) throw new Error(`eightfold requires tenant_url (host) for ${company.slug}`);
  return company.tenantUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
function domainOf(company: AdapterCompany): string {
  const d = company.apiMeta?.domain;
  if (!d) throw new Error(`eightfold requires apiMeta.domain for ${company.slug}`);
  return d;
}

export const eightfoldAdapter: AtsAdapter = {
  provider: "eightfold",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const host = hostOf(company);
    const domain = domainOf(company);
    return paginate<NormalizedPosting>({
      provider: "eightfold",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (start) => {
        const url = `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=${PAGE}&sort_by=relevance`;
        const raw = await atsFetchJson(url, { provider: "eightfold" });
        const parsed = parseOrThrow(ListSchema, raw, { provider: "eightfold", slug: company.slug });
        const items = parsed.positions.map((p) => normalizeEightfold(company, p));
        const total = typeof parsed.count === "number" ? parsed.count : null;
        return { items, total };
      },
    });
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const host = hostOf(company);
    const domain = domainOf(company);
    const url = `https://${host}/api/apply/v2/jobs/${encodeURIComponent(posting.externalId)}?domain=${encodeURIComponent(domain)}`;
    const raw = await atsFetchJson(url, { provider: "eightfold" });
    const parsed = parseOrNull(DetailSchema, raw, { provider: "eightfold", slug: company.slug, what: "detail" });
    if (!parsed) return "";
    const jd = parsed.positions?.[0]?.job_description ?? parsed.job_description ?? "";
    return htmlToText(jd);
  },
};

export function normalizeEightfold(company: AdapterCompany, p: Position): NormalizedPosting {
  const location = p.location ?? (p.locations && p.locations[0]) ?? null;
  return {
    provider: "eightfold",
    externalId: String(p.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.name,
    jobUrl: p.canonicalPositionUrl ?? `https://${hostOf(company)}/careers/job/${p.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(p.job_description ?? ""),
    postedAt: unixToIso(p.t_create),
  };
}
