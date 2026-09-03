// list: POST <tenant>.mynexthire.com/employer/careers/reqlist/get { source:"careers", code:"", filterByBuId:-1 } -> every open requisition inline (plain-text JD) in one call
// jobUrl reproduces the vendor's own base64-encoded client link builder byte-for-byte so the SPA can parse it
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso, tenantOriginOr } from "./shared.js";

// Only statusId the public "careers" source endpoint has ever returned; filtered on defensively.
const OPEN_STATUS_ID = 3;

export const MyNextHireJobSchema = z.object({
  reqId: z.number(),
  statusId: z.number(),
  reqTitle: z.string(),
  location: z.string().nullable().optional(),
  locationAddress: z.string().nullable().optional(),
  jdDisplay: z.string().nullable().optional(),
  approvedOn: z.string().nullable().optional(),
});
export type MyNextHireJob = z.infer<typeof MyNextHireJobSchema>;

const ListResponseSchema = z.object({
  reqDetailsBOList: z.array(MyNextHireJobSchema).nullable().optional(),
});

// Tenant host origin, e.g. "https://swiggy.mynexthire.com".
export function mynexthireBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.mynexthire.com`);
}

export function mynexthireJobUrl(company: AdapterCompany, reqId: number): string {
  const qStringContext = {
    pageType: "jd",
    cvSource: "careers",
    reqId,
    requester: { id: "", code: "", name: "" },
    page: "careers",
    bufilter: -1,
    customFields: {},
  };
  const p = Buffer.from(JSON.stringify(qStringContext), "utf8").toString("base64");
  const eq = encodeURIComponent("=");
  const amp = encodeURIComponent("&");
  return `${mynexthireBase(company)}/employer/jobs/careers?src${eq}careers${amp}p${eq}${p}`;
}

export function normalizeMyNextHire(company: AdapterCompany, j: MyNextHireJob): NormalizedPosting {
  const location = j.location ?? j.locationAddress ?? null;
  return {
    provider: "mynexthire",
    externalId: String(j.reqId),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.reqTitle,
    jobUrl: mynexthireJobUrl(company, j.reqId),
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: htmlToText(j.jdDisplay),
    postedAt: dateToIso(j.approvedOn),
  };
}

export const mynexthireAdapter: AtsAdapter = {
  provider: "mynexthire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `${mynexthireBase(company)}/employer/careers/reqlist/get`;
    const raw = await atsFetchJson(url, {
      method: "POST",
      body: { source: "careers", code: "", filterByBuId: -1 },
      provider: "mynexthire",
    });

    const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "mynexthire", slug: company.slug });

    const jobs = parsed.reqDetailsBOList ?? [];
    return jobs
      .filter((j) => j.statusId === OPEN_STATUS_ID)
      .map((j) => normalizeMyNextHire(company, j));
  },
};
