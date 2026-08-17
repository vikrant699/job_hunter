// src/ats/recruitee.ts — Recruitee hosted career sites (<tenant>.recruitee.com). A plain GET of
// https://<tenant>.recruitee.com/api/offers/ returns the full board with description + requirements
// (both full HTML) inline, no auth/pagination, so no fetchJd needed; filtered defensively to
// status:"published" even though nothing else has been observed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso, tenantOriginOr } from "./shared.js";
import type { JsonValue } from "../util/json.js";

export const RecruiteeOfferSchema = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string(),
  description: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
  careers_url: z.string(),
  careers_apply_url: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  published_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type RecruiteeOffer = z.infer<typeof RecruiteeOfferSchema>;

const ListResponseSchema = z.object({ offers: z.array(RecruiteeOfferSchema) });

export function recruiteeBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.recruitee.com`);
}

function buildJdText(o: RecruiteeOffer): string {
  return [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join("\n\n");
}

export function normalizeRecruitee(company: AdapterCompany, o: RecruiteeOffer): NormalizedPosting {
  return {
    provider: "recruitee",
    externalId: String(o.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: o.title,
    jobUrl: o.careers_url,
    location: o.location ?? null,
    isRemote: o.remote === true || REMOTE_RE.test(o.location ?? ""),
    jdText: buildJdText(o),
    postedAt: dateToIso(o.published_at ?? o.created_at),
  };
}

export function parseRecruiteeOffers(raw: JsonValue, slug: string): RecruiteeOffer[] {
  const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "recruitee", slug });
  return parsed.offers;
}

export function postingsFromRecruiteeJson(company: AdapterCompany, raw: JsonValue): NormalizedPosting[] {
  return parseRecruiteeOffers(raw, company.slug)
    .filter((o) => o.status === "published")
    .map((o) => normalizeRecruitee(company, o));
}

export const recruiteeAdapter: AtsAdapter = {
  provider: "recruitee",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `${recruiteeBase(company)}/api/offers/`;
    const raw = await atsFetchJson(url, { provider: "recruitee" });
    return postingsFromRecruiteeJson(company, raw);
  },
  // Both description and requirements are inline — no fetchJd needed.
};
