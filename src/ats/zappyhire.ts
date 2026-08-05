// src/ats/zappyhire.ts
//
// Zappyhire recruitment boards. The tenant-facing frontend host
// (`<x>careers.zappyhire.com`) does NOT reveal the backend API host or
// generation -- both are baked into the tenant's compiled Angular bundle at
// build time (captured once per tenant from that bundle at registry-seeding
// time) and cached in apiMeta = { backendHost, generation: "new"|"legacy", source? }.
//
// Two backend generations coexist:
//
//   new-gen (e.g. Federal Bank, fed.portal.zappyhire.com): one call, JD inline.
//     POST https://<backendHost>/api/job_portal/dashboard/?sortOrder=descend
//       body {} -> { results: { open_jobs: Job[], registration_open_jobs_count } }
//
//   legacy (e.g. ESAF, zappyhire-esaf-be-prod.zappyhire.com): 3-call chain,
//   JD fetched lazily via fetchJd.
//     GET  .../api/resourcerequirements/career/dashboard/?source=<SRC>
//       -> { results: [{ id, name, job_count }] }                (departments)
//     GET  .../api/resourcerequirements/job/dashboard/?group=<deptId>&source=<SRC>
//       -> { results: [{ id, title, locations }] }                (jobs per dept)
//     GET  .../api/resourcerequirements/job/career/?job=<id>
//       -> { results: { ..., description } }                     (JD, via fetchJd)
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, sleep, INTER_PAGE_DELAY_MS, DEFAULT_MAX_PAGES, paginate, tenantOriginOr } from "./shared.js";

// ---------- api_meta ----------

export interface ZappyhireMeta {
  backendHost: string;
  generation: "new" | "legacy" | "multitenant";
  /** Legacy-only: the `source` query param (e.g. "ESAF"). Null otherwise. */
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

/** Tenant frontend origin. Prefers an explicit tenant_url, else derives the
 *  `<x>careers.zappyhire.com` host from the slug (only used to build fallback
 *  job URLs -- the real API host lives in apiMeta.backendHost). */
function tenantBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}careers.zappyhire.com`);
}

// ---------- new-gen (single-call dashboard, JD inline) ----------

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

/** "13.04.2026" (DD.MM.YYYY, as served by the new-gen dashboard) -> ISO. Null if unparseable. */
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
    // The API always returns an absolute apply-flow URL in practice; the
    // slug-derived path is a defensive fallback only.
    jobUrl: j.job_url || `${tenantBase(company)}/job-detail/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description ?? ""),
    postedAt: parseZappyhireDate(j.job_portal_published_datetime),
  };
}

async function listNewGen(company: AdapterCompany, m: ZappyhireMeta): Promise<NormalizedPosting[]> {
  const url = `https://${m.backendHost}/api/job_portal/dashboard/?sortOrder=descend`;
  const raw = await atsFetchJson(url, { method: "POST", body: {}, provider: "zappyhire" });
  const parsed = parseOrThrow(NewGenResponseSchema, raw, { provider: "zappyhire", slug: company.slug, what: "new-gen" });
  return parsed.results.open_jobs.map((j) => normalizeZappyhireNew(company, j));
}

// ---------- legacy (dept -> jobs -> JD chain) ----------

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
    // apply_url in the JD-detail response is malformed on the live tenant
    // ("https=//..." -- a literal vendor bug), so build our own from the
    // known frontend route instead of trusting it.
    jobUrl: `${tenantBase(company)}/tr/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // fetched lazily via fetchJd
    postedAt: null, // not exposed by the list endpoints; only in the JD-detail call
  };
}

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

// ---------- multitenant (recruitcareers.zappyhire.com shared board) ----------
//
// The shared `recruitcareers.zappyhire.com/en/<slug>` frontend talks to a
// per-tenant, slug-derivable backend host `<slug>.zappyhire-multitenant-be-
// prod.zappyhire.com` (so no bundle capture is needed -- apiMeta.backendHost
// is just that host). Two calls:
//   list: GET .../api/jobs/jobsearch/?page=<n>&page_size=<N>
//     -> { results: { total: { value }, hits: [{ _source: {...} }] } }   (Elasticsearch shape, JD NOT inline)
//   JD:   GET .../api/careers/jobs/<job>/
//     -> { results: { description, ... } }
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
  // The original loop had no cap at all (`for (;;)`) - maxPages here is a
  // genuinely new safety net (the fleet's standard 5000), not a raised-too-
  // low one; it also gains the cap-exit warn if it's ever actually reached.
  const seen = new Set<string>();
  let cumulativeCount = 0; // mirrors the original's `out.size`

  return paginate<NormalizedPosting>({
    provider: "zappyhire",
    company: company.slug,
    pageSize: MT_PAGE_SIZE,
    // No page-length comparison in the original loop either - see the three
    // conditions reproduced below.
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

      // Cross-page dedup is kept as a direct seen-Set (not paginate()'s
      // dedupeBy) because the termination condition below needs the exact
      // same "was this job already counted" signal to compute cumulativeCount
      // faithfully - keeping one mechanism instead of two redundant ones.
      const before = cumulativeCount;
      const newItems: NormalizedPosting[] = [];
      for (const h of hits) {
        const id = String(h._source.job);
        if (seen.has(id)) continue;
        seen.add(id);
        newItems.push(normalizeZappyhireMt(company, h._source));
      }
      cumulativeCount += newItems.length;

      // Reproduces the original's `if (hits.length === 0 || out.size >=
      // expected || out.size === before) break` exactly: `expected` is
      // recomputed fresh from THIS page's own response every time (never
      // latched), matching the original never trusting an earlier page's
      // total once a later page is fetched. Translated into paginate()'s
      // item-count `total` contract (see directemployers/ongig for the same
      // technique): report a total exactly equal to the cumulative offset
      // once any of the three conditions holds, so the loop stops right
      // after this page; null otherwise. (hits.length === 0 is also, on its
      // own, separately caught by paginate()'s own count===0 check via
      // rawCount below - included here anyway to mirror the original
      // condition's exact shape.)
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

// ---------- adapter ----------

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
    // new-gen JDs are already inline (populated in listPostings); the
    // pipeline only calls fetchJd when jdText is empty, so this branch is a
    // defensive no-op in practice.
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
