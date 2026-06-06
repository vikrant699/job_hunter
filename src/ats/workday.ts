import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";

// Workday CXS adapter. Per-tenant URLs like apple.wd1.myworkdayjobs.com/External.
// Two-phase: listPostings (metadata only) then fetchJd (full body) so we only
// pay the per-job HTTP call for postings that survived location + dedup.
interface WorkdayUrlParts {
  base: string;        // "https://apple.wd1.myworkdayjobs.com"
  tenant: string;      // "apple"
  site: string;        // "External"
  cxsBase: string;     // "https://apple.wd1.myworkdayjobs.com/wday/cxs/apple/External"
  uiBase: string;      // "https://apple.wd1.myworkdayjobs.com/en-US/External"
}

function parseTenantUrl(tenantUrl: string): WorkdayUrlParts {
  const u = new URL(tenantUrl);
  const tenant = u.host.split(".")[0];
  if (!tenant) throw new Error(`workday tenant URL missing tenant segment: ${tenantUrl}`);
  const site = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/")[0];
  if (!site) throw new Error(`workday tenant URL missing site segment: ${tenantUrl}`);
  const base = `${u.protocol}//${u.host}`;
  return {
    base,
    tenant,
    site,
    cxsBase: `${base}/wday/cxs/${tenant}/${site}`,
    uiBase: `${base}/en-US/${site}`,
  };
}

const WorkdayJobPostingSchema = z.object({
  title: z.string(),
  externalPath: z.string(),
  locationsText: z.string().nullable().optional(),
  postedOn: z.string().nullable().optional(),
  bulletFields: z.array(z.string()).nullable().optional(),
  jobPostingId: z.string().nullable().optional(),
  shortId: z.string().nullable().optional(),
});
type WorkdayJobPosting = z.infer<typeof WorkdayJobPostingSchema>;

const WorkdayListResponseSchema = z.object({
  total: z.number().nullable().optional(),
  jobPostings: z.array(WorkdayJobPostingSchema),
});

const WorkdayJobDetailSchema = z.object({
  jobPostingInfo: z.object({
    jobDescription: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    locationsText: z.string().nullable().optional(),
    postedOn: z.string().nullable().optional(),
    timeType: z.string().nullable().optional(),
    remoteType: z.string().nullable().optional(),
  }),
});

const REMOTE_HINT_RE = /\b(remote|virtual|work from home|wfh|anywhere)\b/i;

const INTER_PAGE_DELAY_MS = 150;
const PAGE_LIMIT = 20;
const PAGE_WARN_INTERVAL = 100;

// Facet UUIDs differ per tenant, so we discover the India country facet at
// fetch time. Shape varies between tenants — we accept refineFilters/facets/
// filters arrays containing any value object with id + descriptor.
interface DiscoveredFacet {
  param: string;
  uuid: string;
}

// Walks the facet tree (handles both flat and nested shapes) for an India
// country leaf. Returns the param + UUID needed for appliedFacets.
function findIndiaFacetIn(node: unknown): DiscoveredFacet | null {
  if (!node || typeof node !== "object") return null;
  const f = node as Record<string, unknown>;

  // Pick the most specific param name available on THIS node.
  const param = typeof f.facetParameter === "string" ? f.facetParameter
              : typeof f.id === "string" ? f.id
              : null;
  const values = Array.isArray(f.values) ? f.values : null;
  if (!values) return null;

  const looksCountry = param != null && /country|location/i.test(param);

  // Direct check: any value with descriptor=India that has its own id (leaf value).
  if (looksCountry) {
    for (const v of values) {
      if (!v || typeof v !== "object") continue;
      const vo = v as Record<string, unknown>;
      if (typeof vo.descriptor === "string"
          && typeof vo.id === "string"
          && /^\s*india\s*$/i.test(vo.descriptor)) {
        return { param: param!, uuid: vo.id };
      }
    }
  }

  // Recurse into nested facets (each value can itself be a facet group).
  for (const v of values) {
    const nested = findIndiaFacetIn(v);
    if (nested) return nested;
  }
  return null;
}

function findIndiaFacet(data: unknown): DiscoveredFacet | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  for (const key of ["refineFilters", "facets", "filters"]) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      const found = findIndiaFacetIn(f);
      if (found) return found;
    }
  }
  return null;
}

async function discoverIndiaFacet(parts: WorkdayUrlParts): Promise<DiscoveredFacet | null> {
  const data = await atsFetchJson(`${parts.cxsBase}/jobs`, {
    method: "POST",
    body: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" },
    provider: "workday",
  });
  return findIndiaFacet(data);
}

export const workdayAdapter: AtsAdapter = {
  provider: "workday",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);
    const listUrl = `${parts.cxsBase}/jobs`;

    // Probe for an India country facet. Most tenants expose it; legacy ones may
    // not — in that case we paginate unfiltered and the downstream location
    // filter handles India detection from the locationsText.
    const indiaFacet = await discoverIndiaFacet(parts);
    const appliedFacets: Record<string, string[]> = indiaFacet
      ? { [indiaFacet.param]: [indiaFacet.uuid] }
      : {};
    if (!indiaFacet) {
      logger.warn(
        { company: company.slug },
        "workday: no India country facet found; fetching unfiltered (slower)"
      );
    } else {
      logger.debug(
        { company: company.slug, param: indiaFacet.param },
        "workday: applying India country facet"
      );
    }

    const out: NormalizedPosting[] = [];
    let offset = 0;
    // Caterpillar (and presumably others) report `total` correctly only on the
    // FIRST page response; subsequent pages return total=0. We capture the
    // page-0 value once and use that for the offset>=total termination check.
    let totalReported: number | null = null;

    for (let page = 0; ; page++) {
      const data = await atsFetchJson(listUrl, {
        method: "POST",
        body: { appliedFacets, limit: PAGE_LIMIT, offset, searchText: "" },
        provider: "workday",
      });

      const parsed = WorkdayListResponseSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn(
          { company: company.slug, issues: parsed.error.issues.slice(0, 2) },
          "workday list schema mismatch"
        );
        throw new Error(`workday list response failed schema for ${company.slug}`);
      }

      for (const j of parsed.data.jobPostings) {
        out.push(normalizeListing(company, parts, j));
      }

      // Caterpillar (and some others) report `total` correctly only on the
      // first page. Capture once, then use it to terminate even when later
      // pages keep returning PAGE_LIMIT jobs past the real end.
      if (totalReported === null && typeof parsed.data.total === "number" && parsed.data.total > 0) {
        totalReported = parsed.data.total;
      }

      if (parsed.data.jobPostings.length === 0) break;
      if (parsed.data.jobPostings.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
      if (totalReported !== null && offset >= totalReported) break;
      if ((page + 1) % PAGE_WARN_INTERVAL === 0) {
        logger.warn(
          { company: company.slug, pages: page + 1, jobsSoFar: out.length, totalReported },
          "workday pagination still going — unusually large tenant"
        );
      }
      if (INTER_PAGE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
    }

    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);

    // externalPath is stored in the posting's job-detail URL; we squirreled the path
    // into jobUrl during normalizeListing. Reconstruct the CXS detail endpoint.
    const externalPath = extractExternalPathFromJobUrl(posting.jobUrl, parts.uiBase);
    if (!externalPath) {
      throw new Error(`cannot derive externalPath from jobUrl: ${posting.jobUrl}`);
    }
    const detailUrl = `${parts.cxsBase}${externalPath}`;

    const raw = await atsFetchJson(detailUrl, { provider: "workday" });

    const parsed = WorkdayJobDetailSchema.safeParse(raw);
    if (!parsed.success) {
      logger.debug(
        { company: company.slug, externalId: posting.externalId, issues: parsed.error.issues.slice(0, 2) },
        "workday detail schema mismatch"
      );
      return "";
    }
    return htmlToText(parsed.data.jobPostingInfo.jobDescription ?? "");
  },
};

function normalizeListing(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
  j: WorkdayJobPosting
): NormalizedPosting {
  // externalId: prefer shortId/jobPostingId/bulletFields, fall back to externalPath tail.
  const externalId =
    j.shortId ??
    j.jobPostingId ??
    (j.bulletFields && j.bulletFields[0]) ??
    j.externalPath.split("/").pop() ??
    j.externalPath;

  const location = j.locationsText ?? null;
  const isRemote = location ? REMOTE_HINT_RE.test(location) : false;

  return {
    provider: "workday",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    // jobUrl is the human-facing UI URL — useful for Discord links AND we use it
    // to reconstruct externalPath in fetchJd.
    jobUrl: `${parts.uiBase}${j.externalPath}`,
    location,
    isRemote,
    jdText: "",
    postedAt: parsePostedOn(j.postedOn ?? null),
  };
}

function extractExternalPathFromJobUrl(jobUrl: string, uiBase: string): string | null {
  if (!jobUrl.startsWith(uiBase)) return null;
  const path = jobUrl.slice(uiBase.length);
  return path.length > 0 ? path : null;
}

// Workday returns relative date strings like "Posted Today" / "5 Days Ago".
function parsePostedOn(s: string | null): string | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  const now = new Date();

  if (lc.includes("today") || lc.includes("just")) {
    return now.toISOString();
  }
  if (lc.includes("yesterday")) {
    return new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  }
  const m = lc.match(/(\d+)\s*\+?\s*(day|week|month)s?\s*ago/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    return new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  }
  return null;
}
