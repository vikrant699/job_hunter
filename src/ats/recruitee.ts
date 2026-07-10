// src/ats/recruitee.ts — Recruitee hosted career sites (<tenant>.recruitee.com).
//
// A plain GET of the tenant's public offers API returns the full board with
// the complete JD inline, no auth and no pagination:
//
//   GET https://<tenant>.recruitee.com/api/offers/
//     -> { offers: [ { id, title, status, description (HTML),
//                       requirements (HTML), location, remote, tags,
//                       department, careers_url, careers_apply_url,
//                       published_at, ... } ] }
//
// `?limit=` is ignored — the endpoint always returns the full list. Both
// `description` and `requirements` carry full HTML and are concatenated for
// jdText, so no fetchJd is needed. The endpoint has only ever been observed
// returning status:"published" offers, but we filter defensively anyway
// (verified live 2026-07-10 against flextrade + fullcreative tenants).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

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

/** Tenant host origin, e.g. "https://flextrade.recruitee.com". Prefers an
 *  explicit tenant_url host when set, else builds it from the slug. */
export function recruiteeBase(company: AdapterCompany): string {
  if (company.tenantUrl) {
    try {
      return new URL(company.tenantUrl).origin;
    } catch {
      /* fall through to slug-derived host */
    }
  }
  return `https://${company.slug}.recruitee.com`;
}

/** Recruitee's `published_at`/`created_at` use a space-separated "UTC" suffix
 *  ("2026-07-09 07:03:45 UTC") rather than ISO 8601. Returns null on any
 *  unparsable value instead of throwing. */
export function parseRecruiteeDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Concatenate description + requirements (both full HTML) into plain-text JD. */
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
    postedAt: parseRecruiteeDate(o.published_at ?? o.created_at),
  };
}

/** Zod-validate the raw `/api/offers/` body. Throws with an actionable
 *  message (rather than letting a zod error bubble raw) on a schema
 *  mismatch — mirrors zohorecruit's parseJobsIsland. */
export function parseRecruiteeOffers(raw: unknown, slug: string): RecruiteeOffer[] {
  const parsed = ListResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { slug, issues: parsed.error.issues.slice(0, 2) },
      "recruitee list schema mismatch",
    );
    throw new Error(`recruitee list response failed schema for ${slug}`);
  }
  return parsed.data.offers;
}

/** Full JSON -> postings pipeline, exposed so tests cover filtering + mapping
 *  without HTTP (validate -> keep only status:"published" -> normalize). */
export function postingsFromRecruiteeJson(company: AdapterCompany, raw: unknown): NormalizedPosting[] {
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
