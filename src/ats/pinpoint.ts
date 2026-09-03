// src/ats/pinpoint.ts — Pinpoint hosted career sites (<tenant>.pinpointhq.com): GET /postings.json returns the full board with the complete HTML JD inline, no auth/pagination.
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

// The pinpointhq subdomain often differs from the registry slug: use tenant_url only if it's a pinpointhq host, else apiMeta.boardSlug, else the slug — never careers_url (that's the marketing site, not the board host).
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
