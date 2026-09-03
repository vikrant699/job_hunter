import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

// list: <base>/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=<CX_n>&limit=&offset= -> { items: [ { requisitionList: Req[], TotalJobsCount } ] }; base = tenant_url, siteNumber = api_meta.siteNumber
// detail: <base>/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=<id>,siteNumber=<CX_n>
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
    return paginate<NormalizedPosting>({
      provider: "oracle",
      company: company.slug,
      pageSize: PAGE,
      // Oracle CE silently caps a page at 25 items regardless of `limit=` - a sub-PAGE page is normal, not the end; pagination must run to TotalJobsCount / an empty page.
      shortPageEndsPagination: false,
      fetchPage: async (offset) => {
        // limit/offset live inside the finder args - some pods ignore top-level &limit=&offset= entirely and would serve page 1 forever otherwise.
        const url =
          `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
          `?onlyData=true&expand=requisitionList.secondaryLocations` +
          `&finder=findReqs;siteNumber=${encodeURIComponent(site)},limit=${PAGE},offset=${offset}`;
        const raw = await atsFetchJson(url, { provider: "oracle" });
        const parsed = parseOrThrow(ListSchema, raw, { provider: "oracle", slug: company.slug });
        // A stale siteNumber over-collects instead of emptying the board (drops the filter rather than matching nothing); items[0] with requisitionList:[] and TotalJobsCount:0 is the only genuinely-empty signal - oracle.test.ts pins this.
        const item = parsed.items[0];
        const reqs = item?.requisitionList ?? [];
        const items = reqs.map((r) => normalizeOracle(company, r));
        const total = typeof item?.TotalJobsCount === "number" ? item.TotalJobsCount : null;
        return { items, total };
      },
    });
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { base, site } = parts(company);
    const url =
      `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
      `?onlyData=true&expand=all&finder=ById;Id=${encodeURIComponent(posting.externalId)},siteNumber=${encodeURIComponent(site)}`;
    const raw = await atsFetchJson(url, { provider: "oracle" });
    const parsed = parseOrNull(DetailSchema, raw, { provider: "oracle", slug: company.slug, what: "detail" });
    if (!parsed) return "";
    const d = parsed.items[0];
    if (!d) return "";
    const body = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n");
    // Some tenants leave every External*Str empty and put the JD in CorporateDescriptionStr instead.
    if (!body && typeof d.CorporateDescriptionStr === "string" && d.CorporateDescriptionStr.length > 0) {
      return htmlToText(d.CorporateDescriptionStr);
    }
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
