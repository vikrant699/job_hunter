// src/ats/unberry.ts — Unberry ATS (app.unberry.com/careers/<companyId>, e.g. Vahan). list: GET ats-api.unberry.com/api/v3/job/<companyId>?page&size (no location/JD fields).
// detail: GET .../job/job-details/<jobId> -> jobDescription/jobRequirements/jobBenefits HTML; companyId is the opaque mongo id from the careers URL, apiMeta.fixedLocation supplies location since the API carries none.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { paginate } from "./shared.js";

const API_HOST = "https://ats-api.unberry.com";
const PAGE = 50;

const UnberryJobSchema = z.object({
  _id: z.string(),
  jobTitle: z.string(),
  jobLocationType: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
});
type UnberryJob = z.infer<typeof UnberryJobSchema>;

const UnberryMetadataSchema = z.object({
  totalCount: z.number().nullable().optional(),
  hasNext: z.boolean().nullable().optional(),
});

const UnberryListSchema = z.object({
  row: z.array(
    z.object({
      metadata: z.array(UnberryMetadataSchema),
      data: z.array(UnberryJobSchema),
    }),
  ),
});

const UnberryDetailSchema = z.object({
  data: z.object({
    jobDescription: z.string().nullable().optional(),
    jobRequirements: z.string().nullable().optional(),
    jobBenefits: z.string().nullable().optional(),
  }),
});

export function unberryCompanyId(company: AdapterCompany): string {
  const fromMeta = company.apiMeta?.companyId;
  if (fromMeta) return fromMeta;
  const path = new URL(company.careersUrl).pathname.replace(/\/+$/, "");
  const last = path.split("/").pop();
  if (!last) throw new Error(`unberry: cannot derive companyId from ${company.careersUrl} for ${company.slug}`);
  return last;
}

export function unberryListUrl(companyId: string, page: number, size: number = PAGE): string {
  return `${API_HOST}/api/v3/job/${encodeURIComponent(companyId)}?page=${page}&size=${size}`;
}

export function unberryJdUrl(jobId: string): string {
  return `${API_HOST}/api/v3/job/job-details/${encodeURIComponent(jobId)}`;
}

function normalizeUnberry(company: AdapterCompany, companyId: string, j: UnberryJob): NormalizedPosting {
  const location = company.apiMeta?.fixedLocation ?? null;
  return {
    provider: "unberry",
    externalId: j._id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle.trim(),
    jobUrl: `https://app.unberry.com/careers/${companyId}/${j._id}`,
    location,
    isRemote: j.jobLocationType === "remote",
    jdText: "", // two-phase — filled in by fetchJd
    postedAt: j.publishedAt ?? null,
  };
}

export const unberryAdapter: AtsAdapter = {
  provider: "unberry",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const companyId = unberryCompanyId(company);
    return paginate<NormalizedPosting>({
      provider: "unberry",
      company: company.slug,
      pageSize: "infer",
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(unberryListUrl(companyId, page + 1), { provider: "unberry" });
        const parsed = parseOrThrow(UnberryListSchema, raw, { provider: "unberry", slug: company.slug });
        const row = parsed.row[0];
        const jobs = row?.data ?? [];
        const meta = row?.metadata[0];
        // hasNext:false is the API's own end signal; surface it as a total so paginate stops.
        const total = meta?.totalCount ?? (meta?.hasNext === false ? _offset + jobs.length : null);
        return {
          items: jobs.map((j) => normalizeUnberry(company, companyId, j)),
          total,
          rawCount: jobs.length,
        };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(unberryJdUrl(posting.externalId), { provider: "unberry" });
    const parsed = parseOrNull(UnberryDetailSchema, raw, { provider: "unberry", slug: company.slug });
    const detail = parsed?.data;
    if (!detail) return "";
    const sections = [detail.jobDescription, detail.jobRequirements, detail.jobBenefits]
      .filter((s): s is string => Boolean(s && s.trim()));
    return sections.length > 0 ? htmlToText(sections.join("\n")) : "";
  },
};
