// src/ats/oracle.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, sleep, warnDeepPagination, INTER_PAGE_DELAY_MS } from "./shared.js";

// Oracle HCM Cloud Recruiting (CE) public REST API:
//   list:   <base>/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//             ?onlyData=true&expand=requisitionList.secondaryLocations
//             &finder=findReqs;siteNumber=<CX_n>&limit=&offset=
//           -> { items: [ { requisitionList: Req[], TotalJobsCount } ] }
//   detail: <base>/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
//             ?onlyData=true&expand=all&finder=ById;Id=<id>,siteNumber=<CX_n>
// base in tenant_url, siteNumber in api_meta.siteNumber. Two-phase.
const SecondaryLocSchema = z.object({ Name: z.string().nullable().optional() });
const ReqSchema = z.object({
  Id: z.string(),
  Title: z.string(),
  PostedDate: z.string().nullable().optional(),
  PrimaryLocation: z.string().nullable().optional(),
  secondaryLocations: z.array(SecondaryLocSchema).nullable().optional(),
});
type Req = z.infer<typeof ReqSchema>;
const ListItemSchema = z.object({
  TotalJobsCount: z.number().nullable().optional(),
  requisitionList: z.array(ReqSchema).nullable().optional(),
});
const ListSchema = z.object({ items: z.array(ListItemSchema) });
const DetailItemSchema = z.object({
  ExternalDescriptionStr: z.string().nullable().optional(),
  ExternalResponsibilitiesStr: z.string().nullable().optional(),
  ExternalQualificationsStr: z.string().nullable().optional(),
  CorporateDescriptionStr: z.string().nullable().optional(),
});
const DetailSchema = z.object({ items: z.array(DetailItemSchema) });

const PAGE = 200;

function parts(company: AdapterCompany): { base: string; site: string } {
  if (!company.tenantUrl) throw new Error(`oracle requires tenant_url for ${company.slug}`);
  const site = company.apiMeta?.siteNumber;
  if (!site) throw new Error(`oracle requires apiMeta.siteNumber for ${company.slug}`);
  return { base: company.tenantUrl.replace(/\/+$/, ""), site };
}

export const oracleAdapter: AtsAdapter = {
  provider: "oracle",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const { base, site } = parts(company);
    const out: NormalizedPosting[] = [];
    let offset = 0;
    let total: number | null = null;
    for (let page = 0; ; page++) {
      const url =
        `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
        `?onlyData=true&expand=requisitionList.secondaryLocations` +
        `&finder=findReqs;siteNumber=${encodeURIComponent(site)}&limit=${PAGE}&offset=${offset}`;
      const raw = await atsFetchJson(url, { provider: "oracle" });
      const parsed = ListSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "oracle list schema mismatch");
        throw new Error(`oracle list failed schema for ${company.slug}`);
      }
      const item = parsed.data.items[0];
      const reqs = item?.requisitionList ?? [];
      for (const r of reqs) out.push(normalizeOracle(company, r));
      if (total === null && typeof item?.TotalJobsCount === "number") total = item.TotalJobsCount;
      if (reqs.length < PAGE) break;
      offset += PAGE;
      if (total !== null && offset >= total) break;
      warnDeepPagination("oracle", company.slug, page + 1, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { base, site } = parts(company);
    const url =
      `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
      `?onlyData=true&expand=all&finder=ById;Id=${encodeURIComponent(posting.externalId)},siteNumber=${encodeURIComponent(site)}`;
    const raw = await atsFetchJson(url, { provider: "oracle" });
    const parsed = DetailSchema.safeParse(raw);
    if (!parsed.success) return "";
    const d = parsed.data.items[0];
    if (!d) return "";
    const body = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n");
    return htmlToText(body);
  },
};

export function normalizeOracle(company: AdapterCompany, r: Req): NormalizedPosting {
  const { base, site } = parts(company);
  const secondary = (r.secondaryLocations ?? []).map((l) => l.Name ?? "").filter(Boolean).join("; ");
  const location = [r.PrimaryLocation ?? "", secondary].filter(Boolean).join("; ") || null;
  return {
    provider: "oracle",
    externalId: r.Id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.Title,
    jobUrl: `${base}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: r.PostedDate ?? null,
  };
}
