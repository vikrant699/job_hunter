// src/ats/mynexthire.ts — MyNextHire (Indian ATS), e.g. swiggy.mynexthire.com.
// Each tenant is a subdomain: <tenant>.mynexthire.com. The public careers
// board (an Angular SPA at /employer/jobs/careers) is backed by one JSON API
// that returns EVERY publicly listed requisition in a single call:
//
//   list: POST https://<tenant>.mynexthire.com/employer/careers/reqlist/get
//         body { source: "careers", code: "", filterByBuId: -1 }
//         -> { reqDetailsBOList: [ { reqId, statusId, reqTitle, location,
//                                    locationAddress, jdDisplay (plain text),
//                                    approvedOn, ... } ] }
//
// Confirmed live against swiggy.mynexthire.com (111 reqs, ~530KB) and
// netcorecloud.mynexthire.com (21 reqs). An empty body 400s with
// "Source is mandatory." — the body above is what the public board's own
// careers.js sends (encoderFactory.getQStringObject defaults: source
// "careers", code "", filterByBuId -1). No browser UA or WAF workaround is
// needed; the endpoint answers a plain bot UA fine.
//
// The list endpoint already returns the full plain-text JD (jdDisplay), so
// jdText is populated here and no fetchJd is needed. statusId 3 is the only
// value the public "careers" source has ever returned in the wild (verified
// on both tenants above) — i.e. the server already filters to publicly
// open/published requisitions before we see them — but we still filter on it
// defensively in case some tenant's board ever mixes other statuses in.
//
// jobUrl reproduces the vendor's own client-side link builder byte-for-byte
// (careers.js's encoderFactory.getEncodedJobboardLink): a base64-encoded JSON
// blob describing the JD page, with "=" and "&" pre-percent-encoded exactly
// as the vendor encodes them, so the SPA's own
// `decodeURIComponent(query).split("&")` parsing (basePageClass ctor)
// recovers it correctly. Verified by round-tripping their encode/decode logic.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso, tenantOriginOr } from "./shared.js";

// Only statusId observed for a publicly listed/open requisition (and the
// only one the public "careers" source endpoint has ever returned).
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

/** Tenant host origin, e.g. "https://swiggy.mynexthire.com". Prefers an
 *  explicit tenant_url host when set, else builds it from the slug (the
 *  subdomain). */
export function mynexthireBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.mynexthire.com`);
}

/**
 * Deep link into the tenant's own careers SPA for one requisition, built the
 * same way the vendor's own "View"/"Apply" links are (see module header).
 */
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
