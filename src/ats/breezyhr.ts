// list: GET /json -> bare array, no description field; ?limit= is ignored
// jd: GET <job.url>, pick the innermost element with exact class "description" (not "job-description"/"position-description") - stable across both observed themes
import { z } from "zod";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchHtml } from "./http.js";
import { REMOTE_RE, tenantOriginOr } from "./shared.js";
import type { JsonValue } from "../util/json.js";

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

export function breezyBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.breezy.hr`);
}

/** Skips individually malformed items rather than failing the whole board; throws only if the top level isn't an array. */
export function parseBreezyJobs(raw: JsonValue, slug: string): BreezyJob[] {
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

/** Falls back to every matched node if none is a leaf (shouldn't happen, but avoids returning nothing on odd nesting). */
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
