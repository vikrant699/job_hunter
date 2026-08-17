// src/ats/talentfunnel.ts — Talent Funnel (multi-tenant UK ATS). Every customer's
// board is backed by one shared JSON API keyed by a per-customer Tenant UUID.
// list: POST ats-api.talent-funnel.com/js/search/vacancy, header Tenant:<uuid> (required,
// else 403), body {"limit":5000} returns the whole board in one shot. JD: GET
// .../js/vacancy/<vacancyId> -> positionProfile.description (HTML) — the list response
// carries no description. The `?country[0]=IN` URL facet is client-side only and not
// honored server-side, so we fetch the whole board and let the location filter cut India.
// The Tenant UUID lives in apiMeta.tenant.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { logger } from "../logger.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, dateToIso } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const SEARCH_URL = "https://ats-api.talent-funnel.com/js/search/vacancy";
const DETAIL_URL = "https://ats-api.talent-funnel.com/js/vacancy"; // + /<vacancyId>
const PAGE_LIMIT = 5000; // the board's own client default; returns the full board in one call

const TalentfunnelLocationSchema = z
  .object({
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    formattedAddress: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

export const TalentfunnelVacancySchema = z.object({
  vacancyId: z.string(),
  jobTitle: z.string(),
  applicationUrl: z.string().nullable().optional(),
  validFrom: z.string().nullable().optional(),
  hoursType: z.string().nullable().optional(),
  location: TalentfunnelLocationSchema,
});
export type TalentfunnelVacancy = z.infer<typeof TalentfunnelVacancySchema>;

const TalentfunnelResponseSchema = z.object({
  results: z.array(TalentfunnelVacancySchema),
  totalResults: z.number().nullable().optional(),
});

// Per-job detail: the JD HTML lives at positionProfile.description.
const TalentfunnelDetailSchema = z.object({
  positionProfile: z
    .object({ description: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

// The per-customer Tenant UUID (apiMeta.tenant), sent as the `Tenant` header.
export function talentfunnelTenant(company: AdapterCompany): string {
  const tenant = company.apiMeta?.tenant;
  if (tenant === undefined || tenant === "") {
    throw new Error(`talentfunnel requires apiMeta.tenant (UUID) for ${company.slug}`);
  }
  return tenant;
}

function locationString(loc: TalentfunnelVacancy["location"]): string | null {
  if (!loc) return null;
  if (loc.formattedAddress) return loc.formattedAddress;
  const parts = [loc.city, loc.country].filter((s): s is string => typeof s === "string" && s !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

// Maps the shared-API response into normalized postings (jdText filled later by fetchJd).
export function parseTalentfunnelList(raw: JsonValue, company: AdapterCompany): NormalizedPosting[] {
  const body = parseOrThrow(TalentfunnelResponseSchema, raw, { provider: "talentfunnel", slug: company.slug });
  return body.results.map((v) => {
    const location = locationString(v.location);
    return {
      provider: "talentfunnel",
      externalId: v.vacancyId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: v.jobTitle,
      jobUrl: v.applicationUrl ?? company.careersUrl,
      location,
      isRemote: REMOTE_RE.test(`${location ?? ""} ${v.jobTitle}`),
      jdText: "",
      postedAt: dateToIso(v.validFrom) ?? v.validFrom ?? null,
    };
  });
}

export const talentfunnelAdapter: AtsAdapter = {
  provider: "talentfunnel",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const tenant = talentfunnelTenant(company);
    const raw = await atsFetchJson(SEARCH_URL, {
      method: "POST",
      body: { limit: PAGE_LIMIT },
      headers: { Tenant: tenant },
      provider: "talentfunnel",
    });
    return parseTalentfunnelList(raw, company);
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const tenant = talentfunnelTenant(company);
    const raw = await atsFetchJson(`${DETAIL_URL}/${encodeURIComponent(posting.externalId)}`, {
      headers: { Tenant: tenant },
      provider: "talentfunnel",
    });
    const detail = parseOrNull(TalentfunnelDetailSchema, raw, { provider: "talentfunnel", slug: company.slug });
    const html = detail?.positionProfile?.description ?? "";
    if (html === "") {
      logger.warn({ company: company.slug, job: posting.externalId }, "talentfunnel: detail had no positionProfile.description");
    }
    return htmlToText(html);
  },
};
