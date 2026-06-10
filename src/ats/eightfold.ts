// src/ats/eightfold.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, unixToIso, sleep, warnDeepPagination, INTER_PAGE_DELAY_MS } from "./shared.js";

// Eightfold public API:
//   list:   GET <host>/api/apply/v2/jobs?domain=<domain>&start=&num=   -> {positions[],count}
//   detail: GET <host>/api/apply/v2/jobs/<id>?domain=<domain>          -> position w/ job_description
// host stored in tenant_url, jobs domain in api_meta.domain. Two-phase
// (job_description is empty in the list response).
const PositionSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  location: z.string().nullable().optional(),
  locations: z.array(z.string()).nullable().optional(),
  t_create: z.number().nullable().optional(),
  canonicalPositionUrl: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
});
type Position = z.infer<typeof PositionSchema>;
const ListSchema = z.object({ positions: z.array(PositionSchema), count: z.number().nullable().optional() });
const DetailSchema = z.object({
  positions: z.array(PositionSchema).nullable().optional(),
  job_description: z.string().nullable().optional(),
});

const PAGE = 50;

function hostOf(company: AdapterCompany): string {
  if (!company.tenantUrl) throw new Error(`eightfold requires tenant_url (host) for ${company.slug}`);
  return company.tenantUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
function domainOf(company: AdapterCompany): string {
  const d = company.apiMeta?.domain;
  if (!d) throw new Error(`eightfold requires apiMeta.domain for ${company.slug}`);
  return d;
}

export const eightfoldAdapter: AtsAdapter = {
  provider: "eightfold",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const host = hostOf(company);
    const domain = domainOf(company);
    const out: NormalizedPosting[] = [];
    let start = 0;
    let total: number | null = null;
    for (let page = 0; ; page++) {
      const url = `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=${PAGE}&sort_by=relevance`;
      const raw = await atsFetchJson(url, { provider: "eightfold" });
      const parsed = ListSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "eightfold list schema mismatch");
        throw new Error(`eightfold list failed schema for ${company.slug}`);
      }
      for (const p of parsed.data.positions) out.push(normalizeEightfold(company, p));
      if (total === null && typeof parsed.data.count === "number") total = parsed.data.count;
      if (parsed.data.positions.length < PAGE) break;
      start += PAGE;
      if (total !== null && start >= total) break;
      warnDeepPagination("eightfold", company.slug, page + 1, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
    }
    return out;
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const host = hostOf(company);
    const domain = domainOf(company);
    const url = `https://${host}/api/apply/v2/jobs/${encodeURIComponent(posting.externalId)}?domain=${encodeURIComponent(domain)}`;
    const raw = await atsFetchJson(url, { provider: "eightfold" });
    const parsed = DetailSchema.safeParse(raw);
    if (!parsed.success) return "";
    const jd = parsed.data.positions?.[0]?.job_description ?? parsed.data.job_description ?? "";
    return htmlToText(jd);
  },
};

export function normalizeEightfold(company: AdapterCompany, p: Position): NormalizedPosting {
  const location = p.location ?? (p.locations && p.locations[0]) ?? null;
  return {
    provider: "eightfold",
    externalId: String(p.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.name,
    jobUrl: p.canonicalPositionUrl ?? `https://${hostOf(company)}/careers/job/${p.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(p.job_description ?? ""),
    postedAt: unixToIso(p.t_create),
  };
}
