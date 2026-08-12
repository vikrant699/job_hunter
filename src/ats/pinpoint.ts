// src/ats/pinpoint.ts — Pinpoint hosted career sites (<tenant>.pinpointhq.com).
//
// A plain GET of the tenant's public postings feed returns the full board with
// the complete JD inline, no auth and no pagination:
//
//   GET https://<tenant>.pinpointhq.com/postings.json
//     -> { data: [ { id, title, description (HTML), url, workplace_type,
//                     workplace_type_text, employment_type_text,
//                     location: { city, name, province, ... } | null, ... } ] }
//
// `description` carries the full HTML JD, so no fetchJd is needed. Location is a
// structured object (city + province, or a free-text `name`); workplace_type is
// one of remote/hybrid/onsite. The feed carries no posting date, so postedAt is
// always null. Verified live 2026-08-12 against the hiverhq tenant.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const PinpointLocationSchema = z.object({
  city: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  province: z.string().nullable().optional(),
});
export type PinpointLocation = z.infer<typeof PinpointLocationSchema>;

export const PinpointPostingSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string(),
  workplace_type: z.string().nullable().optional(),
  location: PinpointLocationSchema.nullable().optional(),
});
export type PinpointPosting = z.infer<typeof PinpointPostingSchema>;

const ListResponseSchema = z.object({ data: z.array(PinpointPostingSchema) });

/** Tenant host origin, e.g. "https://hiverhq.pinpointhq.com". The pinpointhq
 *  subdomain frequently differs from both the registry slug and the company's
 *  own careers domain, so: use tenant_url only when it is itself a pinpointhq
 *  host, else build from apiMeta.boardSlug, else the slug. Never fall back to
 *  careers_url — that is the marketing site, not the board host. */
export function pinpointBase(company: AdapterCompany): string {
  if (company.tenantUrl) {
    try {
      const u = new URL(company.tenantUrl);
      if (u.host.endsWith(".pinpointhq.com")) return u.origin;
    } catch {
      /* fall through to slug-built host */
    }
  }
  const sub = company.apiMeta?.boardSlug ?? company.slug;
  return `https://${sub}.pinpointhq.com`;
}

/** City + province, falling back to the free-text `name`, else null. */
export function pinpointLocation(loc: PinpointLocation | null | undefined): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.province].filter((s): s is string => Boolean(s && s.trim()));
  if (parts.length > 0) return parts.join(", ");
  return loc.name && loc.name.trim() ? loc.name.trim() : null;
}

export function normalizePinpoint(company: AdapterCompany, p: PinpointPosting): NormalizedPosting {
  const location = pinpointLocation(p.location);
  const isRemote =
    (p.workplace_type ?? "").toLowerCase() === "remote" || (location ? REMOTE_RE.test(location) : false);
  return {
    provider: "pinpoint",
    externalId: String(p.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.title,
    jobUrl: p.url,
    location,
    isRemote,
    jdText: htmlToText(p.description ?? ""),
    postedAt: null, // the postings feed carries no posting date.
  };
}

/** Validate the raw `/postings.json` body and map every row. Throws with an
 *  actionable message on a schema mismatch rather than letting zod bubble raw. */
export function postingsFromPinpointJson(company: AdapterCompany, raw: JsonValue): NormalizedPosting[] {
  const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "pinpoint", slug: company.slug });
  return parsed.data.map((p) => normalizePinpoint(company, p));
}

export const pinpointAdapter: AtsAdapter = {
  provider: "pinpoint",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `${pinpointBase(company)}/postings.json`;
    const raw = await atsFetchJson(url, { provider: "pinpoint" });
    return postingsFromPinpointJson(company, raw);
  },
  // description is inline in the list feed — no fetchJd needed.
};
