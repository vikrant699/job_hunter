// src/ats/paramai.ts — Param.ai careers boards (<tenant>.app.param.ai). One
// unauthenticated GET returns every posting grouped by department:
//   GET https://<tenant>.app.param.ai/api/career/get_job/
//     -> { data: { "<Department>": { jobs: [{ id, title, req_id, slug,
//          locations: [string], description (HTML JD) }] }, ... } }
// apiMeta.subdomain selects the tenant (e.g. "maruti"). JD inline. Verified
// live on Maruti Suzuki (784 jobs across 32 departments, 2026-07-18).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

export const ParamAiJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  slug: z.string().nullable().optional(),
  req_id: z.union([z.string(), z.number()]).nullable().optional(),
  locations: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type ParamAiJob = z.infer<typeof ParamAiJobSchema>;

const DeptSchema = z.object({ jobs: z.array(ParamAiJobSchema).nullable().optional() });
export const ParamAiResponseSchema = z.object({ data: z.record(z.string(), DeptSchema) });

function subdomain(company: AdapterCompany): string {
  const s = company.apiMeta?.subdomain;
  if (s) return s;
  const host = new URL(company.tenantUrl ?? company.careersUrl).host;
  const m = host.match(/^([a-z0-9-]+)\.app\.param\.ai$/i);
  if (m) return m[1]!;
  throw new Error(`paramai requires apiMeta.subdomain for ${company.slug}`);
}

export function normalizeParamAi(company: AdapterCompany, sub: string, j: ParamAiJob): NormalizedPosting {
  const location = (j.locations ?? []).map((l) => l.trim()).filter(Boolean).join("; ") || null;
  return {
    provider: "paramai",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.slug ? `https://${sub}.app.param.ai/careers/${j.slug}` : `https://${sub}.app.param.ai/careers`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.created_at ?? null,
  };
}

export const paramaiAdapter: AtsAdapter = {
  provider: "paramai",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const sub = subdomain(company);
    const raw = await atsFetchJson(`https://${sub}.app.param.ai/api/career/get_job/`, { provider: "paramai" });
    const parsed = ParamAiResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 3) }, "paramai schema mismatch");
      throw new Error(`paramai response failed schema for ${company.slug}`);
    }
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const dept of Object.values(parsed.data.data)) {
      for (const j of dept.jobs ?? []) {
        const p = normalizeParamAi(company, sub, j);
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
    }
    return out;
  },
};
