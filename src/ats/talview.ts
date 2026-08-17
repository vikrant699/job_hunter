// src/ats/talview.ts — Talview's own careers board (careers.talview.com). categories:
// GET apiv4.talview.com/attend/menu-card?organization_id=<org> -> [{id,name}]. jobs: GET
// pages.talview.com/api/attend/menu-card-assessment?menu_card_id=<id>&organization_id=<org>.
// Only jobs with a truthy first_assessment_section_id are live/published. `location` is
// always null — the description carries a "Based in: <City>, <State>, <Country>" line
// instead, parsed here. apiMeta.organizationId selects the tenant (default 183 = Talview Inc).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep } from "./shared.js";

const DEFAULT_ORG = "183";

export const TalviewCategorySchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
});
const TalviewCategoriesSchema = z.array(TalviewCategorySchema);

export const TalviewJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  descriptionHTML: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  first_assessment_section_id: z.union([z.string(), z.number()]).nullable().optional(),
});
export type TalviewJob = z.infer<typeof TalviewJobSchema>;
const TalviewJobsSchema = z.array(TalviewJobSchema);

function orgId(company: AdapterCompany): string {
  return company.apiMeta?.organizationId ?? DEFAULT_ORG;
}

export function talviewCategoriesUrl(org: string): string {
  return `https://apiv4.talview.com/attend/menu-card?organization_id=${org}`;
}

export function talviewJobsUrl(org: string, menuCardId: string): string {
  return `https://pages.talview.com/api/attend/menu-card-assessment?menu_card_id=${menuCardId}&organization_id=${org}`;
}

// "Based in: Bengaluru, Karnataka, India" -> the city/state/country string; null if absent.
export function talviewLocationFromDescription(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/Based in:?\s*([^\n.]+)/i);
  return m?.[1]?.trim() || null;
}

export function normalizeTalviewJob(company: AdapterCompany, j: TalviewJob): NormalizedPosting {
  const jdText = j.descriptionHTML ? htmlToText(j.descriptionHTML) : (j.description ?? "").trim();
  const location = j.location?.trim() || talviewLocationFromDescription(jdText);
  return {
    provider: "talview",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: company.tenantUrl ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText,
    postedAt: null,
  };
}

export const talviewAdapter: AtsAdapter = {
  provider: "talview",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const org = orgId(company);
    const rawCats = await atsFetchJson(talviewCategoriesUrl(org), { provider: "talview" });
    const cats = parseOrThrow(TalviewCategoriesSchema, rawCats, { provider: "talview", slug: company.slug, what: "categories" });

    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const cat of cats) {
      const rawJobs = await atsFetchJson(talviewJobsUrl(org, String(cat.id)), { provider: "talview" });
      const jobs = parseOrThrow(TalviewJobsSchema, rawJobs, {
        provider: "talview",
        slug: company.slug,
        what: `jobs (category ${cat.id})`,
      });
      for (const j of jobs) {
        if (!j.first_assessment_section_id) continue; // unpublished
        const p = normalizeTalviewJob(company, j);
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  },
};
