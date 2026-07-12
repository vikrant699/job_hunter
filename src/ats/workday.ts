import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, parsePostedOn, paginate } from "./shared.js";
import { discoverIndiaFacet } from "./workday-facet.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema, getObj } from "../util/json.js";

// Workday CXS adapter. Per-tenant URLs like apple.wd1.myworkdayjobs.com/External.
// Two-phase: listPostings (metadata only) then fetchJd (full body) so we only
// pay the per-job HTTP call for postings that survived location + dedup.
interface WorkdayUrlParts {
  base: string;
  tenant: string;
  site: string;
  cxsBase: string;
  uiBase: string;
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
  // Raw facet tree (shape varies a lot by tenant — some leaves are flat
  // id+count values, some nest a sub-facet group first). Only consumed by
  // the 2000-total-latch partitioning path below; left unvalidated beyond
  // "is JSON" since we defensively narrow it with getObj at read time.
  facets: z.array(JsonValueSchema).nullable().optional(),
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

const PAGE_LIMIT = 20;

export const workdayAdapter: AtsAdapter = {
  provider: "workday",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);
    const listUrl = `${parts.cxsBase}/jobs`;

    // Probe for an India country facet. Most tenants expose it; legacy ones may
    // not — in that case we paginate unfiltered (bounded by the pagination cap
    // below) and the downstream location filter handles India detection from
    // the locationsText.
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

    // Caterpillar (and some others) report `total` correctly only on the
    // first page; `paginate` latches the first non-zero value it sees and
    // uses it to terminate even when later pages keep returning PAGE_LIMIT
    // jobs past the real end.
    //
    // Separately, some "monster board" tenants (e.g. Genpact) report `total`
    // as exactly 2000 — a Workday CXS server-side cap — even though the real
    // board is much larger (verified live: Genpact's own jobFamilyGroup facet
    // counts summed to 3077). crawlWorkdayPostings detects that exact value
    // and, when a flat facet is available, partitions the crawl by it so each
    // slice stays under the cap.
    return crawlWorkdayPostings(company, appliedFacets, indiaFacet?.param ?? null, async (offset, facets) => {
      const data = await atsFetchJson(listUrl, {
        method: "POST",
        body: { appliedFacets: facets, limit: PAGE_LIMIT, offset, searchText: "" },
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

      const items = parsed.data.jobPostings.map((j) => normalizeWorkdayListing(company, j, parts));
      const total = typeof parsed.data.total === "number" && parsed.data.total > 0 ? parsed.data.total : null;
      return { items, total, facets: parsed.data.facets ?? null };
    });
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

// Some tenants (e.g. Accenture) omit `locationsText` entirely; the city then
// only shows up as one of the display-only `bulletFields`, typically as
// `[reqId, location]` with no jobPostingId/shortId present either. Take the
// first bulletField that isn't the req id and isn't known non-location
// display metadata ("Full time", "40 hrs/week"). Location values seen live
// are plain city names ("Milan", "London") as often as "City, Country"
// strings, so we can't require a comma — the req-id/metadata exclusions are
// the only filter.
const REQ_ID_RE = /^(req|r)[-_]?\d+$/i;
const NON_LOCATION_BULLET_RE =
  /^(full|part)[\s-]*time$|^\d+(\.\d+)?\s*\+?\s*hrs?\.?\s*\/?\s*(per\s*)?week$|^(permanent|temporary|contract(or)?|intern(ship)?)$/i;

function locationFromBulletFields(j: WorkdayJobPosting): string | null {
  if (!j.bulletFields) return null;
  const idFields = new Set([j.jobPostingId, j.shortId].filter((v): v is string => typeof v === "string"));
  for (const raw of j.bulletFields) {
    const field = raw.trim();
    if (!field) continue;
    if (idFields.has(field)) continue;
    if (REQ_ID_RE.test(field)) continue;
    if (NON_LOCATION_BULLET_RE.test(field)) continue;
    return field;
  }
  return null;
}

export function normalizeWorkdayListing(
  company: AdapterCompany,
  j: WorkdayJobPosting,
  parts?: WorkdayUrlParts
): NormalizedPosting {
  // externalId: prefer shortId/jobPostingId, fall back to externalPath tail.
  // bulletFields is display metadata ("Full time", "40 hrs/week") — never an ID;
  // using it would collide every posting on tenants that omit shortId.
  const externalId =
    j.shortId ??
    j.jobPostingId ??
    j.externalPath.split("/").pop() ??
    j.externalPath;

  const location = j.locationsText ?? locationFromBulletFields(j);
  const isRemote = location ? REMOTE_RE.test(location) : false;
  const uiBase = parts?.uiBase ?? "";

  return {
    provider: "workday",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    // jobUrl is the human-facing UI URL — useful for Discord links AND we use it
    // to reconstruct externalPath in fetchJd.
    jobUrl: `${uiBase}${j.externalPath}`,
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

// --- 2000-total-latch partitioning ---------------------------------------
//
// Some Workday "monster board" tenants (Genpact confirmed live) report
// `total` as exactly 2000 regardless of how far past that offset you page —
// a server-side cap, not the real job count (Genpact's own jobFamilyGroup
// facet counts summed to 3077). When that happens we partition the crawl by
// a flat facet (one `appliedFacets` selection per value) so each slice's own
// reported total stays under the cap, and union the results by externalId.

const WORKDAY_TOTAL_LATCH = 2000;

export interface PartitionFacetValue {
  id: string;
  count: number;
}

export interface PartitionFacet {
  param: string;
  values: PartitionFacetValue[];
}

/** Result of fetching one Workday listing page, including the raw facet tree
 *  (needed only to decide/execute latch partitioning — see above). */
export interface WorkdayPageResult {
  items: NormalizedPosting[];
  total: number | null;
  facets: JsonValue[] | null;
}

export type WorkdayPageFetcher = (
  offset: number,
  facets: Record<string, string[]>
) => Promise<WorkdayPageResult>;

// A "leaf" facet has values that are themselves directly selectable
// (id + count), as opposed to a nested facet whose values are further facet
// groups (e.g. Genpact's locationMainGroup, whose one top-level value is a
// sub-facet named "locations" with no id/count of its own — the real
// per-location leaves are one level deeper). Only leaf facets are safe to
// select on with a single `appliedFacets` entry.
function leafValuesOf(node: JsonValue): PartitionFacetValue[] | null {
  const obj = getObj(node);
  if (!obj) return null;
  const valuesRaw = obj["values"];
  if (!Array.isArray(valuesRaw)) return null;

  const out: PartitionFacetValue[] = [];
  for (const v of valuesRaw) {
    const vObj = getObj(v);
    if (!vObj) return null;
    const id = vObj["id"];
    const count = vObj["count"];
    if (typeof id !== "string" || typeof count !== "number") return null;
    out.push({ id, count });
  }
  return out;
}

/**
 * Picks the best facet to partition the crawl by: the flat leaf facet (see
 * `leafValuesOf`) with the most distinct values — more buckets means a
 * smaller max-bucket size, which is less likely to hit the 2000 cap itself.
 * Facets with fewer than 2 values aren't useful for partitioning. Excludes
 * `excludeParam` (the India country facet already applied, if any) so we
 * don't try to select on a param that's already fixed in `appliedFacets`.
 */
export function selectPartitionFacet(
  facets: JsonValue[] | null | undefined,
  excludeParam: string | null
): PartitionFacet | null {
  if (!facets || facets.length === 0) return null;

  let best: PartitionFacet | null = null;
  for (const f of facets) {
    const obj = getObj(f);
    if (!obj) continue;
    const paramRaw = obj["facetParameter"] ?? obj["id"];
    const param = typeof paramRaw === "string" ? paramRaw : null;
    if (!param || param === excludeParam) continue;

    const values = leafValuesOf(f);
    if (!values || values.length < 2) continue;

    if (!best || values.length > best.values.length) {
      best = { param, values };
    }
  }
  return best;
}

/** Plain offset-paginated crawl (the pre-partitioning behavior), reusing the
 *  already-fetched first page instead of refetching it. */
async function crawlFlat(
  company: AdapterCompany,
  baseFacets: Record<string, string[]>,
  fetchPage: WorkdayPageFetcher,
  seededFirstPage: WorkdayPageResult
): Promise<NormalizedPosting[]> {
  let usedSeed = false;
  return paginate<NormalizedPosting>({
    provider: "workday",
    company: company.slug,
    pageSize: PAGE_LIMIT,
    fetchPage: async (offset) => {
      if (offset === 0 && !usedSeed) {
        usedSeed = true;
        return { items: seededFirstPage.items, total: seededFirstPage.total };
      }
      const page = await fetchPage(offset, baseFacets);
      return { items: page.items, total: page.total };
    },
  });
}

/**
 * Orchestrates a Workday listing crawl, transparently switching to
 * facet-partitioned crawling when the reported total latches at exactly
 * 2000. `fetchPage` is injected so this stays unit-testable with fixture
 * payloads — the real adapter wires it to `atsFetchJson` (see `listPostings`
 * above).
 */
export async function crawlWorkdayPostings(
  company: AdapterCompany,
  baseFacets: Record<string, string[]>,
  excludeFacetParam: string | null,
  fetchPage: WorkdayPageFetcher
): Promise<NormalizedPosting[]> {
  const peek = await fetchPage(0, baseFacets);

  if (peek.total !== WORKDAY_TOTAL_LATCH) {
    return crawlFlat(company, baseFacets, fetchPage, peek);
  }

  const partitionFacet = selectPartitionFacet(peek.facets, excludeFacetParam);
  if (!partitionFacet) {
    logger.warn(
      { company: company.slug },
      "workday: total latched at 2000 — board likely truncated (no partitionable facet found)"
    );
    return crawlFlat(company, baseFacets, fetchPage, peek);
  }

  logger.warn(
    { company: company.slug, facet: partitionFacet.param, partitions: partitionFacet.values.length },
    "workday: total latched at 2000 — partitioning by facet to avoid truncation"
  );

  const merged = new Map<string, NormalizedPosting>();
  for (const value of partitionFacet.values) {
    const partitionFacets = { ...baseFacets, [partitionFacet.param]: [value.id] };
    const items = await paginate<NormalizedPosting>({
      provider: "workday",
      company: company.slug,
      pageSize: PAGE_LIMIT,
      fetchPage: async (offset) => {
        const page = await fetchPage(offset, partitionFacets);
        if (page.total === WORKDAY_TOTAL_LATCH) {
          logger.warn(
            { company: company.slug, facet: partitionFacet.param, value: value.id },
            "workday: partition itself latched at 2000 — may still be truncated"
          );
        }
        return { items: page.items, total: page.total };
      },
    });
    for (const p of items) merged.set(p.externalId, p);
  }
  return [...merged.values()];
}
