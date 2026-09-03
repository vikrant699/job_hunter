// src/ats/zappyhire.ts — Zappyhire recruitment boards; the frontend never reveals the backend API host or generation, so both are captured once from the tenant's compiled Angular bundle at registry-seeding time.
// Cached as apiMeta = { backendHost, generation: "new"|"legacy"|"multitenant", source? }; each generation has its own endpoint recipe noted above its code below.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, sleep, INTER_PAGE_DELAY_MS, DEFAULT_MAX_PAGES, paginate, tenantOriginOr } from "./shared.js";

export interface ZappyhireMeta {
  backendHost: string;
  generation: "new" | "legacy" | "multitenant";
  // Legacy-only: the `source` query param (e.g. "ESAF"). Null otherwise.
  source: string | null;
}

function meta(company: AdapterCompany): ZappyhireMeta {
  const backendHost = company.apiMeta?.backendHost;
  const generation = company.apiMeta?.generation;
  if (!backendHost) {
    throw new Error(`zappyhire adapter requires apiMeta.backendHost for ${company.slug}`);
  }
  if (generation !== "new" && generation !== "legacy" && generation !== "multitenant") {
    throw new Error(`zappyhire adapter requires apiMeta.generation ("new"|"legacy"|"multitenant") for ${company.slug}`);
  }
  return { backendHost, generation, source: company.apiMeta?.source ?? null };
}

// Tenant frontend origin: prefers an explicit tenant_url, else derives <x>careers.zappyhire.com (fallback job URLs only — the real API host is apiMeta.backendHost).
function tenantBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}careers.zappyhire.com`);
}

const NewJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  deployment_location: z.string().nullable().optional(),
  job_url: z.string().nullable().optional(),
  job_portal_published_datetime: z.string().nullable().optional(),
});
export type NewGenJob = z.infer<typeof NewJobSchema>;

const NewGenResponseSchema = z.object({
  results: z.object({
    open_jobs: z.array(NewJobSchema),
    registration_open_jobs_count: z.number().nullable().optional(),
  }),
});

// "13.04.2026" (DD.MM.YYYY) -> ISO. Null if unparseable.
export function parseZappyhireDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeZappyhireNew(company: AdapterCompany, j: NewGenJob): NormalizedPosting {
  const location = j.deployment_location ?? null;
  return {
    provider: "zappyhire",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    // The API always returns an absolute apply-flow URL in practice; the slug-derived path is a fallback only.
    jobUrl: j.job_url || `${tenantBase(company)}/job-detail/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description ?? ""),
    postedAt: parseZappyhireDate(j.job_portal_published_datetime),
  };
}

// new-gen (e.g. Federal Bank): one call, JD inline — POST https://<backendHost>/api/job_portal/dashboard/?sortOrder=descend, body {} -> { results: { open_jobs: Job[] } }.
async function listNewGen(company: AdapterCompany, m: ZappyhireMeta): Promise<NormalizedPosting[]> {
  const url = `https://${m.backendHost}/api/job_portal/dashboard/?sortOrder=descend`;
  const raw = await atsFetchJson(url, { method: "POST", body: {}, provider: "zappyhire" });
  const parsed = parseOrThrow(NewGenResponseSchema, raw, { provider: "zappyhire", slug: company.slug, what: "new-gen" });
  return parsed.results.open_jobs.map((j) => normalizeZappyhireNew(company, j));
}

const DeptSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().nullable().optional(),
  job_count: z.number().nullable().optional(),
});
const DeptResponseSchema = z.object({ results: z.array(DeptSchema) });

const LegacyJobSummarySchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  locations: z.string().nullable().optional(),
});
export type LegacyJobSummary = z.infer<typeof LegacyJobSummarySchema>;
const LegacyJobsResponseSchema = z.object({ results: z.array(LegacyJobSummarySchema) });

const LegacyJobDetailSchema = z.object({
  description: z.string().nullable().optional(),
});
const LegacyDetailResponseSchema = z.object({ results: LegacyJobDetailSchema });

export function normalizeZappyhireLegacy(company: AdapterCompany, j: LegacyJobSummary): NormalizedPosting {
  const location = j.locations ?? null;
  return {
    provider: "zappyhire",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    // apply_url in the JD-detail response is malformed on the live tenant (literal vendor bug: "https=//..."), so build our own from the known frontend route instead.
    jobUrl: `${tenantBase(company)}/tr/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // fetched lazily via fetchJd
    postedAt: null, // not exposed by the list endpoints; only in the JD-detail call
  };
}

// legacy (e.g. ESAF): 3-call chain — GET .../career/dashboard/?source=<SRC> (departments), GET .../job/dashboard/?group=<deptId>&source=<SRC> (jobs), GET .../job/career/?job=<id> via fetchJd (JD).
async function listLegacy(company: AdapterCompany, m: ZappyhireMeta): Promise<NormalizedPosting[]> {
  if (!m.source) throw new Error(`zappyhire legacy adapter requires apiMeta.source for ${company.slug}`);
  const source = m.source;

  const deptUrl = `https://${m.backendHost}/api/resourcerequirements/career/dashboard/?source=${encodeURIComponent(source)}`;
  const deptRaw = await atsFetchJson(deptUrl, { provider: "zappyhire" });
  const deptParsed = parseOrThrow(DeptResponseSchema, deptRaw, {
    provider: "zappyhire",
    slug: company.slug,
    what: "legacy department",
  });

  // Dedup by id: a job could in principle be double-listed across departments.
  const out = new Map<string, NormalizedPosting>();
  for (const dept of deptParsed.results) {
    const jobsUrl =
      `https://${m.backendHost}/api/resourcerequirements/job/dashboard/` +
      `?group=${encodeURIComponent(String(dept.id))}&source=${encodeURIComponent(source)}`;
    const jobsRaw = await atsFetchJson(jobsUrl, { provider: "zappyhire" });
    const jobsParsed = parseOrNull(LegacyJobsResponseSchema, jobsRaw, {
      provider: "zappyhire",
      slug: company.slug,
      what: `legacy jobs (dept ${dept.id})`,
    });
    if (!jobsParsed) continue; // one bad department shouldn't abort the whole tenant
    for (const j of jobsParsed.results) {
      out.set(String(j.id), normalizeZappyhireLegacy(company, j));
    }
    await sleep(INTER_PAGE_DELAY_MS);
  }
  return [...out.values()];
}

// multitenant (recruitcareers.zappyhire.com/en/<slug>): backend host is slug-derivable (<slug>.zappyhire-multitenant-be-prod.zappyhire.com), no bundle capture needed.
// list: GET .../api/jobs/jobsearch/?page=<n>&page_size=<N> -> Elasticsearch-shaped hits (JD not inline); JD: GET .../api/careers/jobs/<job>/ -> { results: { description } }.
const MT_PAGE_SIZE = 50;

const MtSourceSchema = z.object({
  job: z.union([z.number(), z.string()]),
  title: z.string(),
  location: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  job_type: z.string().nullable().optional(),
});
export type MtSource = z.infer<typeof MtSourceSchema>;
const MtResponseSchema = z.object({
  results: z.object({
    total: z.object({ value: z.number() }).nullable().optional(),
    hits: z.array(z.object({ _source: MtSourceSchema })),
  }),
});
const MtDetailResponseSchema = z.object({
  results: z.object({ description: z.string().nullable().optional() }),
});

export function normalizeZappyhireMt(company: AdapterCompany, s: MtSource): NormalizedPosting {
  const location = s.location ?? null;
  return {
    provider: "zappyhire",
    externalId: String(s.job),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: s.title,
    jobUrl: `https://recruitcareers.zappyhire.com/${company.slug}/apply?source=1&company=1&job=${s.job}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // fetched lazily via fetchJd (careers/jobs detail)
    postedAt: null, // list endpoint omits the publish date; only the detail call has it
  };
}

async function listMultitenant(company: AdapterCompany, m: ZappyhireMeta): Promise<NormalizedPosting[]> {
  const seen = new Set<string>();
  let cumulativeCount = 0;

  return paginate<NormalizedPosting>({
    provider: "zappyhire",
    company: company.slug,
    pageSize: MT_PAGE_SIZE,
    shortPageEndsPagination: false,
    maxPages: DEFAULT_MAX_PAGES,
    fetchPage: async (offset, page) => {
      const pageNo = page + 1; // API is 1-based
      const url = `https://${m.backendHost}/api/jobs/jobsearch/?page=${pageNo}&page_size=${MT_PAGE_SIZE}`;
      const raw = await atsFetchJson(url, { provider: "zappyhire" });
      const parsed = parseOrThrow(MtResponseSchema, raw, {
        provider: "zappyhire",
        slug: company.slug,
        what: `multitenant (page ${pageNo})`,
      });
      const { hits, total } = parsed.results;

      const before = cumulativeCount;
      const newItems: NormalizedPosting[] = [];
      for (const h of hits) {
        const id = String(h._source.job);
        if (seen.has(id)) continue;
        seen.add(id);
        newItems.push(normalizeZappyhireMt(company, h._source));
      }
      cumulativeCount += newItems.length;

      // Stop once the page is empty, cumulative count reaches this page's own reported total (recomputed fresh each time, never latched), or nothing new was added.
      const expected = total?.value ?? hits.length;
      const isDone = hits.length === 0 || cumulativeCount >= expected || cumulativeCount === before;

      return {
        items: newItems,
        rawCount: hits.length,
        total: isDone ? offset + hits.length : null,
      };
    },
  });
}

export const zappyhireAdapter: AtsAdapter = {
  provider: "zappyhire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const m = meta(company);
    if (m.generation === "new") return listNewGen(company, m);
    if (m.generation === "multitenant") return listMultitenant(company, m);
    return listLegacy(company, m);
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const m = meta(company);
    // new-gen JDs are already inline; the pipeline only calls fetchJd when jdText is empty, so this branch is a defensive no-op in practice.
    if (m.generation === "new") return posting.jdText;

    if (m.generation === "multitenant") {
      const url = `https://${m.backendHost}/api/careers/jobs/${encodeURIComponent(posting.externalId)}/`;
      const raw = await atsFetchJson(url, { provider: "zappyhire" });
      const parsed = parseOrNull(MtDetailResponseSchema, raw, {
        provider: "zappyhire",
        slug: company.slug,
        what: `multitenant detail ${posting.externalId}`,
      });
      if (!parsed) return "";
      return htmlToText(parsed.results.description ?? "");
    }

    const url = `https://${m.backendHost}/api/resourcerequirements/job/career/?job=${encodeURIComponent(posting.externalId)}`;
    const raw = await atsFetchJson(url, { provider: "zappyhire" });
    const parsed = parseOrNull(LegacyDetailResponseSchema, raw, {
      provider: "zappyhire",
      slug: company.slug,
      what: `legacy detail ${posting.externalId}`,
    });
    if (!parsed) return "";
    return htmlToText(parsed.results.description ?? "");
  },
};
