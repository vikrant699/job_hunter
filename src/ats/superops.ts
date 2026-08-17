// src/ats/superops.ts — SuperOps careers (superops.com), a Gatsby static site: GET /page-data/careers/page-data.json for staticQueryHashes, then GET /page-data/sq/d/<hash>.json until the one holding data.<X>.careers[] is found.
// Hashes change on every redeploy, so they're re-discovered each run rather than hardcoded; JD isn't in the list payload, fetched from /careers/<slug> instead.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";
import * as cheerio from "cheerio";
import type { JsonValue } from "../util/json.js";

export const SuperopsCareerSchema = z.object({
  jobTitle: z.string(),
  slug: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  natureOfJob: z.string().nullable().optional(),
});
export type SuperopsCareer = z.infer<typeof SuperopsCareerSchema>;

const PageDataSchema = z.object({ staticQueryHashes: z.array(z.union([z.string(), z.number()])) });
const SqBlobSchema = z.object({ data: z.record(z.string(), JsonValueSchema) });
const CareersNodeSchema = z.object({ careers: z.array(SuperopsCareerSchema) });

/** Find the careers[] array inside any sq-data blob (shape: data.<Anything>.careers); null when this blob isn't the one. */
export function extractSuperopsCareers(blob: JsonValue): SuperopsCareer[] | null {
  const parsed = SqBlobSchema.safeParse(blob);
  if (!parsed.success) return null;
  for (const v of Object.values(parsed.data.data)) {
    const node = CareersNodeSchema.safeParse(v);
    if (node.success) return node.data.careers;
  }
  return null;
}

export const superopsAdapter: AtsAdapter = {
  provider: "superops",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = tenantOrigin(company);
    const pageData = await atsFetchJson(`${origin}/page-data/careers/page-data.json`, { provider: "superops" });
    const pd = PageDataSchema.safeParse(pageData);
    if (!pd.success) throw new Error(`superops page-data failed schema for ${company.slug}`);

    let careers: SuperopsCareer[] | null = null;
    for (const hash of pd.data.staticQueryHashes) {
      const blob = await atsFetchJson(`${origin}/page-data/sq/d/${hash}.json`, { provider: "superops" }).catch(
        () => null,
      );
      const found = blob ? extractSuperopsCareers(blob) : null;
      if (found) { careers = found; break; }
    }
    if (!careers) return [];

    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const c of careers) {
      const externalId = c.slug ?? c.jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      out.push({
        provider: "superops",
        externalId,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: c.jobTitle,
        jobUrl: c.slug ? `${origin}/careers/${c.slug}` : `${origin}/careers`,
        location: c.location ?? null,
        isRemote: c.location ? REMOTE_RE.test(c.location) : false,
        jdText: "",
        postedAt: null,
      });
    }
    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "superops" });
    const $ = cheerio.load(html);
    const main = $("main").first();
    return htmlToText(main.length > 0 ? (main.html() ?? "") : $("body").html() ?? "");
  },
};
