// src/ats/paramai.ts — Param.ai careers boards (<tenant>.app.param.ai): one unauthenticated GET returns every posting grouped by department, with the JD inline.
// apiMeta.subdomain selects the tenant.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { matchGroup } from "../util/regex.js";

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
  const sub = matchGroup(/^([a-z0-9-]+)\.app\.param\.ai$/i, host);
  if (sub) return sub;
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
    const parsed = parseOrThrow(ParamAiResponseSchema, raw, { provider: "paramai", slug: company.slug });
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const dept of Object.values(parsed.data)) {
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
