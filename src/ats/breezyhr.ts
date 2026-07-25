// src/ats/breezyhr.ts
import { z } from "zod";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchHtml } from "./http.js";
import { REMOTE_RE, tenantOriginOr } from "./shared.js";

// BreezyHR public boards: <tenant>.breezy.hr
//   list: GET https://<tenant>.breezy.hr/json  (no auth; ?limit= is ignored,
//         the server always returns the full board) -> a bare JSON ARRAY of
//         jobs: [{ id, friendly_id, name, url, published_date, type:{...},
//         location:{...}, department, ... }]. The list carries NO description
//         field, so jdText is left empty here and fetchJd does the real work.
//   JD:   GET <job.url> (== https://<tenant>.breezy.hr/p/<friendly_id>)
//         -> server HTML. The JD body lives in the innermost `.description`
//         div; this is stable across both observed themes:
//           "simple" theme: <div class="job-description"><div class="description">
//           "bold" theme:   <div id="description" class="...position-description">
//                              ... <div class="description"> (sibling of the
//                              breadcrumbs/sidebar/apply-buttons blocks)
//         so selecting the innermost element with the exact class
//         "description" (not "job-description"/"position-description", which
//         don't match a `.description` class selector) works for both.

const BreezyLocationSchema = z
  .object({
    name: z.string().nullable().optional(),
    is_remote: z.boolean().nullable().optional(),
  })
  .nullable()
  .optional();

export const BreezyJobSchema = z.object({
  id: z.string(),
  friendly_id: z.string(),
  name: z.string(),
  url: z.string().nullable().optional(),
  published_date: z.string().nullable().optional(),
  type: z
    .object({ id: z.string().nullable().optional(), name: z.string().nullable().optional() })
    .nullable()
    .optional(),
  location: BreezyLocationSchema,
  department: z.string().nullable().optional(),
});
export type BreezyJob = z.infer<typeof BreezyJobSchema>;

/** Tenant host origin, e.g. "https://talentmovers.breezy.hr". Prefers an
 *  explicit tenant_url host when set, else builds it from the slug. */
export function breezyBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.breezy.hr`);
}

/**
 * Validate the raw `/json` response (a bare array) and skip individual
 * malformed items rather than failing the whole board — a public,
 * unauthenticated endpoint like this can carry the occasional odd record.
 * Throws only if the top-level shape isn't an array at all.
 */
export function parseBreezyJobs(raw: unknown, slug: string): BreezyJob[] {
  if (!Array.isArray(raw)) {
    throw new Error(`breezyhr list response for ${slug} was not an array`);
  }
  const out: BreezyJob[] = [];
  for (const item of raw) {
    const parsed = BreezyJobSchema.safeParse(item);
    if (!parsed.success) {
      logger.debug({ slug, issues: parsed.error.issues.slice(0, 2) }, "breezyhr item schema skip");
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

export function normalizeBreezyhr(company: AdapterCompany, j: BreezyJob): NormalizedPosting {
  const base = breezyBase(company);
  const location = j.location?.name ?? null;
  const isRemote = j.location?.is_remote === true || (location ? REMOTE_RE.test(location) : false);
  const jobUrl = j.url && /^https?:\/\//i.test(j.url) ? j.url : `${base}/p/${j.friendly_id}`;

  return {
    provider: "breezyhr",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.name,
    jobUrl,
    location,
    isRemote,
    jdText: "", // the /json list carries no description — see fetchJd
    postedAt: j.published_date ?? null,
  };
}

/**
 * Extract the JD body's plain text from a `/p/<friendly_id>` page. Picks the
 * innermost element(s) with the exact class "description" (there's normally
 * exactly one — see module doc for the two theme shapes); falls back to every
 * matched node if none is a leaf, which shouldn't happen in practice but
 * keeps this from silently returning nothing on an unexpected nesting.
 */
export function extractBreezyJd(html: string): string {
  const $ = cheerio.load(html);
  const all = $(".description").toArray();
  if (all.length === 0) return "";
  const leaves = all.filter((el) => $(el).find(".description").length === 0);
  const target = leaves.length > 0 ? leaves : all;
  const combined = target.map((el) => $(el).html() ?? "").join("\n");
  return htmlToText(combined);
}

export const breezyhrAdapter: AtsAdapter = {
  provider: "breezyhr",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `${breezyBase(company)}/json`;
    const raw = await atsFetchJson(url, { provider: "breezyhr" });
    const jobs = parseBreezyJobs(raw, company.slug);
    return jobs.map((j) => normalizeBreezyhr(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "breezyhr" });
    return extractBreezyJd(html);
  },
};
