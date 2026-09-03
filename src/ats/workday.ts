import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, parsePostedOn, paginate } from "./shared.js";
import { discoverIndiaFacet, pinnedFacet } from "./workdayFacet.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema, getObj } from "../util/json.js";
import { looksLikeChallengePage } from "../util/errorCause.js";

// Workday CXS adapter: per-tenant URLs like apple.wd1.myworkdayjobs.com/External.
// Two-phase: listPostings (metadata only) then fetchJd (full body) - the per-job HTTP call is only paid for postings that survived location + dedup.
interface WorkdayUrlParts {
  base: string;
  tenant: string;
  site: string;
  cxsBase: string;
  uiBase: string;
}

function buildWorkdayParts(base: string, tenant: string, site: string): WorkdayUrlParts {
  return {
    base,
    tenant,
    site,
    cxsBase: `${base}/wday/cxs/${tenant}/${site}`,
    uiBase: `${base}/en-US/${site}`,
  };
}

function parseTenantUrl(tenantUrl: string): WorkdayUrlParts {
  const u = new URL(tenantUrl);
  const tenant = u.host.split(".")[0];
  if (!tenant) throw new Error(`workday tenant URL missing tenant segment: ${tenantUrl}`);
  const site = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/")[0];
  if (!site) throw new Error(`workday tenant URL missing site segment: ${tenantUrl}`);
  const base = `${u.protocol}//${u.host}`;
  return buildWorkdayParts(base, tenant, site);
}

// robots.txt names real career-site segments via "Allow: /<site>/" and "Sitemap: .../<site>/siteMap.xml" lines - used to recover from a stale/wrong site name in tenant_url (see discoverDriftedSite below).
const ALLOW_LINE_RE = /^allow:\s*\/([^/\r\n]+)\/?\s*$/i;
const SITEMAP_DIRECTIVE_RE = /^sitemap:\s*(\S+)\s*$/i;
const SITEMAP_SITE_RE = /\/([^/]+)\/sitemap\.xml$/i;
const NON_SITE_NAMES = new Set(["wday", "refreshfacet", "events"]);

export function parseWorkdaySites(robotsTxt: string): string[] {
  const seen = new Set<string>();
  const sites: string[] = [];
  for (const rawLine of robotsTxt.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let site: string | null = null;
    const allowMatch = ALLOW_LINE_RE.exec(line);
    if (allowMatch) {
      site = allowMatch[1] ?? null;
    } else {
      const sitemapMatch = SITEMAP_DIRECTIVE_RE.exec(line);
      const sitemapUrl = sitemapMatch?.[1];
      if (sitemapUrl) {
        const urlMatch = SITEMAP_SITE_RE.exec(sitemapUrl);
        site = urlMatch?.[1] ?? null;
      }
    }
    if (!site) continue;
    if (NON_SITE_NAMES.has(site.toLowerCase())) continue;
    if (site.includes(".")) continue;
    if (seen.has(site)) continue;
    seen.add(site);
    sites.push(site);
  }
  return sites;
}

// A wrong site name in tenant_url 404s, but so can an unrelated request-burst throttle serving HTML instead of JSON (see config.ts's PROVIDER_THROTTLE_TABLE) - so an HTML body alone doesn't prove drift; only robots.txt not listing the configured site at all does (see discoverDriftedSite's containment check).
const HTML_NOT_JSON_RE = /Unexpected token '<'|<!doctype\b|<html\b|is not valid JSON|Unexpected end of JSON input/i;

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function isWorkdayNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message === "workday 404";
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function isWorkdayHtmlBodyError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) return false;
  if (looksLikeChallengePage(err.message)) return false;
  return HTML_NOT_JSON_RE.test(err.message);
}

// Runs once, only after the first listing attempt fails 404/HTML-not-JSON; returns corrected parts to retry with, or null when it's not drift or the robots.txt evidence isn't a clean single-site swap (a human repoints the row instead).
async function discoverDriftedSite(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  err: unknown,
): Promise<WorkdayUrlParts | null> {
  if (!isWorkdayNotFoundError(err) && !isWorkdayHtmlBodyError(err)) return null;

  let robotsTxt: string;
  try {
    robotsTxt = await atsFetchText(`${parts.base}/robots.txt`, { provider: "workday" });
  } catch {
    return null;
  }

  const sites = parseWorkdaySites(robotsTxt);
  if (sites.includes(parts.site)) return null; // configured site is valid; the failure wasn't drift

  if (sites.length !== 1) {
    logger.warn(
      { company: company.slug, configuredSite: parts.site, sites },
      "workday: site drift check found zero or multiple candidate sites; leaving as-is",
    );
    return null;
  }

  const discoveredSite = sites[0];
  if (!discoveredSite) return null;
  logger.warn(
    { company: company.slug, configuredSite: parts.site, discoveredSite },
    "workday site drift",
  );
  return buildWorkdayParts(parts.base, parts.tenant, discoveredSite);
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
  // Items are validated one at a time in parseWorkdayListPage: a stub row with no title/externalPath must not fail a 1000+ posting board.
  jobPostings: z.array(JsonValueSchema),
  // Raw facet tree, shape varies a lot by tenant; only consumed by the 2000-total-latch partitioning path below, so left unvalidated beyond "is JSON".
  facets: z.array(JsonValueSchema).nullable().optional(),
});

export interface WorkdayListPage {
  postings: WorkdayJobPosting[];
  total: number | null;
  facets: JsonValue[] | null;
  skipped: number;
}

// Validates one CXS /jobs page: items are judged individually (a stub row is skipped), and only EVERY item failing on a non-empty page throws (that shape means the field names moved, not that a row is a fluke).
export function parseWorkdayListPage(raw: JsonValue, slug: string): WorkdayListPage {
  const envelope = parseOrThrow(WorkdayListResponseSchema, raw, { provider: "workday", slug });
  const postings: WorkdayJobPosting[] = [];
  let skipped = 0;
  for (const item of envelope.jobPostings) {
    const parsed = WorkdayJobPostingSchema.safeParse(item);
    if (parsed.success) postings.push(parsed.data);
    else skipped++;
  }
  if (skipped > 0 && postings.length === 0) {
    throw new Error(
      `workday list response failed schema for ${slug} (all ${skipped} jobPostings rejected)`,
    );
  }
  if (skipped > 0) {
    logger.warn({ slug, skipped }, "workday: skipped stub jobPostings missing title/externalPath");
  }
  const total = typeof envelope.total === "number" && envelope.total > 0 ? envelope.total : null;
  return { postings, total, facets: envelope.facets ?? null, skipped };
}

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

// Body of listPostings, factored out so a site-drift retry (see discoverDriftedSite) can rerun it whole against corrected parts - facet discovery included, since it hits the same (possibly wrong) site too.
async function runWorkdayListing(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
): Promise<NormalizedPosting[]> {
  const listUrl = `${parts.cxsBase}/jobs`;

  // An api_meta pin (facetParam + facetValueIds) wins outright, for tenants whose location facet has no "India"-token leaves (lowes: a flat locations facet, India leaf just "Bengaluru"); otherwise probe for an India country facet, and legacy tenants without one paginate unfiltered and rely on the downstream location filter.
  const indiaFacet = pinnedFacet(company.apiMeta) ?? (await discoverIndiaFacet(parts));
  const appliedFacets: Record<string, string[]> = indiaFacet
    ? { [indiaFacet.param]: indiaFacet.uuids }
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

  // Some tenants (Caterpillar) report `total` correctly only on the first page; paginate latches the first non-zero value it sees.
  return crawlWorkdayPostings(company, appliedFacets, indiaFacet?.param ?? null, async (offset, facets) => {
    const data = await atsFetchJson(listUrl, {
      method: "POST",
      body: { appliedFacets: facets, limit: PAGE_LIMIT, offset, searchText: "" },
      provider: "workday",
    });

    const page = parseWorkdayListPage(data, company.slug);

    const items = page.postings.map((j) => normalizeWorkdayListing(company, j, parts));
    return { items, total: page.total, facets: page.facets };
  });
}

export const workdayAdapter: AtsAdapter = {
  provider: "workday",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);
    try {
      return await runWorkdayListing(company, parts);
    } catch (err) {
      const discovered = await discoverDriftedSite(company, parts, err);
      if (!discovered) throw err;
      return runWorkdayListing(company, discovered);
    }
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);

    // externalPath was squirreled into jobUrl during normalizeListing; reconstruct the CXS detail endpoint.
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

// Some tenants (Accenture) omit locationsText entirely, so the city only shows up as one of the display-only bulletFields (typically [reqId, location]) - take the first bulletField that isn't the req id or known non-location metadata ("Full time", "40 hrs/week"); values are plain city names as often as "City, Country", so no comma requirement.
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
  // externalId: prefer shortId/jobPostingId, fall back to externalPath tail; bulletFields is display metadata, never an ID (using it would collide postings on tenants without shortId).
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
    // jobUrl is the human-facing UI URL; also used to reconstruct externalPath in fetchJd.
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

// Some "monster board" tenants (Genpact confirmed live) cap reported `total` at exactly 2000 regardless of offset; crawlWorkdayPostings detects the latch and partitions the crawl by a flat facet so each slice's own total stays under the cap.
const WORKDAY_TOTAL_LATCH = 2000;

export interface PartitionFacetValue {
  id: string;
  count: number;
}

export interface PartitionFacet {
  param: string;
  values: PartitionFacetValue[];
}

// Result of fetching one Workday listing page, including the raw facet tree (needed only for latch partitioning above).
export interface WorkdayPageResult {
  items: NormalizedPosting[];
  total: number | null;
  facets: JsonValue[] | null;
}

export type WorkdayPageFetcher = (
  offset: number,
  facets: Record<string, string[]>
) => Promise<WorkdayPageResult>;

// A "leaf" facet has values that are themselves directly selectable (id + count), as opposed to a nested facet whose values are further facet groups; only leaf facets are safe to select on with a single appliedFacets entry.
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

// Picks the flat leaf facet with the most distinct values (smaller max-bucket size, less likely to hit the cap itself); excludes excludeParam (the India facet already applied).
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

// Plain offset-paginated crawl (pre-partitioning behavior), reusing the already-fetched first page.
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

// fetchPage is injected for unit-testability.
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
