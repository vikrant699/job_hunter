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
import type { Caught } from "../util/errorCause.js";
import { looksLikeChallengePage } from "../util/errorCause.js";

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

// robots.txt "Allow: /<site>/" and "Sitemap: .../<site>/siteMap.xml" lines recover from a stale/wrong site name in tenant_url.
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

// A wrong site name 404s, but a request-burst throttle also serves HTML instead of JSON, so HTML alone doesn't prove drift; only robots.txt not listing the configured site does.
const HTML_NOT_JSON_RE = /Unexpected token '<'|<!doctype\b|<html\b|is not valid JSON|Unexpected end of JSON input/i;

function isWorkdayNotFoundError(err: Caught): boolean {
  return err instanceof Error && err.message === "workday 404";
}

function isWorkdayHtmlBodyError(err: Caught): boolean {
  if (!(err instanceof SyntaxError)) return false;
  if (looksLikeChallengePage(err.message)) return false;
  return HTML_NOT_JSON_RE.test(err.message);
}

async function discoverDriftedSite(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
  err: Caught,
): Promise<WorkdayUrlParts | null> {
  if (!isWorkdayNotFoundError(err) && !isWorkdayHtmlBodyError(err)) return null;

  let robotsTxt: string;
  try {
    robotsTxt = await atsFetchText(`${parts.base}/robots.txt`, { provider: "workday" });
  } catch {
    return null;
  }

  const sites = parseWorkdaySites(robotsTxt);
  if (sites.includes(parts.site)) return null;

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
  // Items validated one at a time: a stub row with no title/externalPath must not fail a 1000+ posting board.
  jobPostings: z.array(JsonValueSchema),
  // Facet tree shape varies a lot by tenant; unvalidated beyond "is JSON".
  facets: z.array(JsonValueSchema).nullable().optional(),
});

export interface WorkdayListPage {
  postings: WorkdayJobPosting[];
  total: number | null;
  facets: JsonValue[] | null;
  skipped: number;
}

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
    additionalLocations: z.array(z.string()).nullable().optional(),
    country: z.object({ descriptor: z.string().nullable().optional() }).nullable().optional(),
    locationsText: z.string().nullable().optional(),
    postedOn: z.string().nullable().optional(),
    timeType: z.string().nullable().optional(),
    remoteType: z.string().nullable().optional(),
  }),
});

const PAGE_LIMIT = 20;

async function runWorkdayListing(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
): Promise<NormalizedPosting[]> {
  const listUrl = `${parts.cxsBase}/jobs`;

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

  // Some tenants (Caterpillar) report `total` correctly only on the first page; paginate latches the first non-zero value.
  return crawlWorkdayPostings(company, appliedFacets, indiaFacet?.param ?? null, async (offset, facets) => {
    const data = await atsFetchJson(listUrl, {
      method: "POST",
      body: { appliedFacets: facets, limit: PAGE_LIMIT, offset, searchText: "" },
      provider: "workday",
    });

    const page = parseWorkdayListPage(data, company.slug);

    const items = page.postings.map((j) => normalizeWorkdayListing(company, j, parts, indiaFacet !== null));
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
    const info = parsed.data.jobPostingInfo;
    if (posting.location === null || MULTI_LOCATION_RE.test(posting.location)) {
      const resolved = detailLocation(info.location, info.additionalLocations, posting.location === null ? info.country?.descriptor : "India");
      if (resolved) posting.location = resolved;
    }
    return htmlToText(info.jobDescription ?? "");
  },
};

// The listing only says "2 Locations"; the detail names every city.
function detailLocation(primary: string | null | undefined, additional: string[] | null | undefined, country: string | null | undefined): string | null {
  const cities = [primary, ...(additional ?? [])].map((c) => c?.trim() ?? "").filter((c) => c !== "");
  if (cities.length === 0) return null;
  const joined = cities.join(" | ");
  return country && !joined.toLowerCase().includes(country.toLowerCase()) ? `${joined}, ${country}` : joined;
}

// Some tenants (Accenture) omit locationsText, so the city only appears in bulletFields (typically [reqId, location]); take the first that isn't the req id or known metadata ("Full time", "40 hrs/week").
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

const MULTI_LOCATION_RE = /^\d+\s+Locations\b/i;

// indiaScoped: the India facet was applied, so every listed posting has an India location.
function listingLocation(raw: string | null, indiaScoped: boolean): string | null {
  if (raw === null) return null;
  if (MULTI_LOCATION_RE.test(raw)) return indiaScoped ? `${raw}, India` : null;
  return indiaScoped && !/\bindia\b/i.test(raw) ? `${raw}, India` : raw;
}

export function normalizeWorkdayListing(
  company: AdapterCompany,
  j: WorkdayJobPosting,
  parts?: WorkdayUrlParts,
  indiaScoped = false,
): NormalizedPosting {
  // bulletFields is display metadata, never an ID: it would collide postings on tenants without shortId.
  const externalId =
    j.shortId ??
    j.jobPostingId ??
    j.externalPath.split("/").pop() ??
    j.externalPath;

  const raw = j.locationsText ?? locationFromBulletFields(j);
  const location = listingLocation(raw, indiaScoped);
  const isRemote = raw ? REMOTE_RE.test(raw) : false;
  const uiBase = parts?.uiBase ?? "";

  return {
    provider: "workday",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
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

// Some tenants (Genpact) cap reported `total` at exactly 2000 regardless of offset; the crawl detects the latch and partitions by a flat facet to stay under the cap.
const WORKDAY_TOTAL_LATCH = 2000;

export interface PartitionFacetValue {
  id: string;
  count: number;
}

export interface PartitionFacet {
  param: string;
  values: PartitionFacetValue[];
}

export interface WorkdayPageResult {
  items: NormalizedPosting[];
  total: number | null;
  facets: JsonValue[] | null;
}

export type WorkdayPageFetcher = (
  offset: number,
  facets: Record<string, string[]>
) => Promise<WorkdayPageResult>;

// Only leaf facets (values directly selectable, id + count) are safe to select on with a single appliedFacets entry.
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

// Picks the flat leaf facet with the most distinct values (smaller max bucket, less likely to hit the cap itself), excluding the India facet.
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
