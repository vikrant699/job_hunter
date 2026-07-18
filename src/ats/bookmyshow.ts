// src/ats/bookmyshow.ts — BookMyShow careers, served by BMS's own PWA API
// (a same-origin proxy over their Trakstar tenant — callers never need the
// Trakstar key):
//
//   GET https://in.bookmyshow.com/pwa/api/careers/job-listing?limit=100&offset=<N>
//     -> { meta: { offset, limit, total }, objects: [{ id, title,
//          description (full JD HTML), location: { city }, country, state,
//          team, position_type, is_remote_allowed, hosted_url,
//          created_date, close_date }] }
//
// Cloudflare fronts the whole in.bookmyshow.com origin and the API pins
// requests to the SPA's own session: Node fetch 403s on TLS fingerprint, and
// even an IN-PAGE fetch replay 403s because the SPA's call carries a
// session-generated `x-bms-id` header we can't mint (verified live
// 2026-07-18 by diffing the SPA's request headers against a replay in the
// same page). The SPA fires the job-listing call on boot, though — so this
// adapter passively CAPTURES that response via browserCaptureResponse. The
// single un-paged call the SPA makes returns the whole board (~24 postings);
// meta.total is asserted so growth past one response fails loudly instead of
// truncating silently.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { browserCaptureResponse } from "./browser-fetch.js";
import { REMOTE_RE, unixToIso } from "./shared.js";

const BOARD_URL = "https://in.bookmyshow.com/careers";
const LIST_URL_SUBSTRING = "/pwa/api/careers/job-listing";

export const BmsJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  location: z.object({ city: z.string().nullable().optional() }).nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  position_type: z.string().nullable().optional(),
  is_remote_allowed: z.boolean().nullable().optional(),
  hosted_url: z.string().nullable().optional(),
  created_date: z.union([z.string(), z.number()]).nullable().optional(),
});
export type BmsJob = z.infer<typeof BmsJobSchema>;

export const BmsResponseSchema = z.object({
  meta: z.object({
    offset: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    total: z.number().nullable().optional(),
  }).nullable().optional(),
  objects: z.array(BmsJobSchema),
});


export function normalizeBmsJob(company: AdapterCompany, j: BmsJob): NormalizedPosting {
  const city = j.location?.city?.trim() || null;
  const location = city ?? j.state?.trim() ?? null;
  return {
    provider: "bookmyshow",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.hosted_url?.trim() || BOARD_URL,
    location,
    isRemote: !!j.is_remote_allowed || (location !== null && REMOTE_RE.test(location)),
    jdText: j.description ? htmlToText(j.description) : "",
    postedAt:
      typeof j.created_date === "number"
        ? unixToIso(j.created_date)
        : (j.created_date ?? null),
  };
}

export const bookmyshowAdapter: AtsAdapter = {
  provider: "bookmyshow",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const body = await browserCaptureResponse(BOARD_URL, LIST_URL_SUBSTRING);
    const parsed = BmsResponseSchema.safeParse(JSON.parse(body) as unknown);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 3) }, "bookmyshow schema mismatch");
      throw new Error(`bookmyshow list response failed schema for ${company.slug}`);
    }

    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const j of parsed.data.objects) {
      const p = normalizeBmsJob(company, j);
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }

    // The board is far under one page today; if it ever outgrows the limit,
    // fail loudly rather than silently truncating (never-truncate policy).
    const total = parsed.data.meta?.total ?? null;
    if (total !== null && out.length < total) {
      throw new Error(
        `bookmyshow board grew past one page (${out.length}/${total}) — add offset paging to the adapter`,
      );
    }

    return out;
  },
};
