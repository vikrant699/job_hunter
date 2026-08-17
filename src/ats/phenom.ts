// src/ats/phenom.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, getObj, tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { matchGroup } from "../util/regex.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { logger } from "../logger.js";
import { describeError } from "../util/errorCause.js";

// Eager-load boards at/above this size get the India-filtered widgets probe instead of a full walk.
const WIDGETS_PREFER_THRESHOLD = 600;
const PAGE = 50;

export const PhenomJobSchema = z.object({
  jobId: z.union([z.string(), z.number()]).nullable().optional(),
  reqId: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string(),
  cityStateCountry: z.string().nullable().optional(),
  cityState: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  postedDate: z.string().nullable().optional(),
  dateCreated: z.string().nullable().optional(),
  descriptionTeaser: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
});
export type PhenomJob = z.infer<typeof PhenomJobSchema>;

// Anchored at the closing </script> so a literal `};` inside a string value can't truncate the blob.
export function extractPhenomDdo(html: string): JsonValue | null {
  const raw = matchGroup(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*<\/script>/, html)
    ?? matchGroup(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});/, html);
  if (raw === null) return null;
  return tryParseJson(raw);
}

// The locale prefix is the first two path segments of the tenant's search URL. This page carries
// the FULL description in its own phApp.ddo island — the search ddo only has a ~300-char teaser.
export function phenomJobPageUrl(tenantUrl: string, jobId: string): string {
  const u = new URL(tenantUrl);
  const segs = u.pathname.split("/").filter(Boolean);
  const locale = segs.slice(0, 2).join("/");
  return `${u.protocol}//${u.host}/${locale ? `${locale}/` : ""}job/${encodeURIComponent(jobId)}`;
}

// True when the tenant search URL carries the two-segment locale prefix (/in/en, /us/en, ...) that
// phenomJobPageUrl needs; without it every posting's JD page 404s (looks like a per-job defect).
export function phenomTenantHasLocale(tenantUrl: string): boolean {
  return new URL(tenantUrl).pathname.split("/").filter(Boolean).length >= 2;
}

export function phenomJobDescriptionFrom(ddo: JsonValue): string | null {
  const parseResult = JsonValueSchema.safeParse(ddo);
  const d: JsonValue | null = parseResult.success ? parseResult.data : null;
  const job = getObj(getObj(getObj(d, "jobDetail"), "data"), "job");
  const description = job?.["description"];
  return typeof description === "string" && description.length > 0 ? description : null;
}

export function phenomJobsFrom(ddo: JsonValue): { jobs: JsonValue[]; totalHits: number } {
  const parseResult = JsonValueSchema.safeParse(ddo);
  const d: JsonValue | null = parseResult.success ? parseResult.data : null;
  const nodeObj = getObj(d, "eagerLoadRefineSearch") ?? getObj(d, "refineSearch");
  const nodeData = getObj(nodeObj, "data");
  const jobs = nodeData?.["jobs"];
  const jobsArr = Array.isArray(jobs) ? jobs : [];
  const nodeCounts = getObj(nodeData, "counts");
  const totalHits = Number(nodeObj?.["totalHits"] ?? nodeCounts?.["totalHits"] ?? jobsArr.length);
  return { jobs: jobsArr, totalHits };
}

export function normalizePhenom(company: AdapterCompany, j: PhenomJob): NormalizedPosting {
  const location = j.cityStateCountry ?? j.cityState ?? j.location ?? null;
  const externalId = String(j.jobId ?? j.reqId ?? "");
  // Some tenants serve applyUrl as "" or null on every job; fall back to the canonical per-job
  // page (not tenantUrl, which would link the whole board to its search-results page).
  const jobPage = company.tenantUrl !== null && externalId !== ""
    ? phenomJobPageUrl(company.tenantUrl, externalId)
    : null;
  return {
    provider: "phenom",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: (j.applyUrl !== null && j.applyUrl !== undefined && j.applyUrl !== "" ? j.applyUrl : null) ?? jobPage ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    // Left empty: the search ddo only carries a ~300-char teaser. fetchJd pulls the full JD.
    jdText: "",
    postedAt: j.postedDate ?? j.dateCreated ?? null,
  };
}

// Phenom's widget XHR — the search API the SPA itself calls. Some tenants ship an empty
// eagerLoadRefineSearch and load every job through this endpoint instead, so scraping their HTML
// yields nothing. `country: ["India"]` filters server-side, avoiding a fetch of the full global board.
export function phenomWidgetsUrl(tenantUrl: string): string {
  const u = new URL(tenantUrl);
  return `${u.protocol}//${u.host}/widgets`;
}

export function phenomWidgetsBody(from: number, size: number, indiaOnly = true): Record<string, JsonValue> {
  return {
    lang: "en",
    deviceType: "desktop",
    country: "global",
    pageName: "search-results",
    ddoKey: "refineSearch",
    sortBy: "",
    subsearch: "",
    from,
    jobs: true,
    counts: true,
    all_fields: ["category", "country", "state", "city", "type"],
    size,
    clearAll: false,
    jdsource: "facets",
    isSliderEnable: false,
    pageId: "page11",
    siteType: "external",
    keywords: "",
    global: true,
    ...(indiaOnly ? { selected_fields: { country: ["India"] } } : {}),
    locationData: {},
  };
}

export const phenomAdapter: AtsAdapter = {
  provider: "phenom",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) throw new Error(`phenom requires tenant_url (search URL) for ${company.slug}`);
    const tenantUrl = company.tenantUrl;
    // Checked up front so a bad tenant URL is ONE actionable config error rather
    // than a full board of "no jobDetail description" JD failures.
    if (!phenomTenantHasLocale(tenantUrl)) {
      throw new Error(
        `phenom tenant_url is missing the /<country>/<lang> locale segment for ${company.slug}: ${tenantUrl}`,
      );
    }

    const toItems = (jobs: JsonValue[]): NormalizedPosting[] => {
      const items: NormalizedPosting[] = [];
      for (const raw of jobs) {
        const parsed = PhenomJobSchema.safeParse(raw);
        // Skip postings with no stable id — they'd collide on the dedup key as empty strings.
        if (parsed.success && (parsed.data.jobId != null || parsed.data.reqId != null)) {
          items.push(normalizePhenom(company, parsed.data));
        }
      }
      return items;
    };

    const fetchWidgetsPage2 = async (from: number, indiaOnly: boolean): Promise<{ jobs: JsonValue[]; totalHits: number }> => {
      const raw = await atsFetchJson(phenomWidgetsUrl(tenantUrl), {
        method: "POST",
        body: phenomWidgetsBody(from, PAGE, indiaOnly),
        provider: "phenom",
        userAgent: BROWSER_UA,
        headers: { Origin: new URL(tenantUrl).origin, Referer: tenantUrl },
      });
      return phenomJobsFrom(raw);
    };
    const fetchWidgetsPage = async (from: number): Promise<{ jobs: JsonValue[]; totalHits: number }> =>
      fetchWidgetsPage2(from, true);

    // Decided once on page 0 (tenants whose eager-load is empty serve jobs only from the widget XHR).
    let useWidgets = false;

    return paginate<NormalizedPosting>({
      provider: "phenom",
      company: company.slug,
      pageSize: PAGE,
      // The server may cap a page below `size` without meaning "last page" — only a zero-item page
      // or reaching totalHits ends pagination.
      shortPageEndsPagination: false,
      // Some tenants ignore `from` and repeat page 0, or return overlapping pages — dedup absorbs both.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (from, page) => {
        if (useWidgets) {
          const { jobs, totalHits } = await fetchWidgetsPage(from);
          return { items: toItems(jobs), total: totalHits, rawCount: jobs.length };
        }

        const sep = tenantUrl.includes("?") ? "&" : "?";
        const url = `${tenantUrl}${sep}from=${from}&size=${PAGE}`;
        const html = await atsFetchText(url, { provider: "phenom" });
        const ddo = extractPhenomDdo(html);
        if (!ddo) {
          if (page === 0) throw new Error(`phenom: no phApp.ddo island for ${company.slug}`);
          return { items: [], total: null };
        }
        const { jobs, totalHits } = phenomJobsFrom(ddo);

        // Empty eager-load on page 0 means this tenant renders client-side — switch to the widget API.
        if (page === 0 && jobs.length === 0) {
          const widget = await fetchWidgetsPage(from);
          if (widget.jobs.length > 0) {
            useWidgets = true;
            logger.info(
              { company: company.slug, totalHits: widget.totalHits },
              "phenom: empty eager-load, using the widget XHR for this tenant",
            );
            return { items: toItems(widget.jobs), total: widget.totalHits, rawCount: widget.jobs.length };
          }
        }

        // Large global board: prefer the India-filtered widget XHR over walking thousands of
        // eager-load pages. A zero-hit India answer is trusted only once the unfiltered widget call
        // confirms the endpoint is live for this tenant; otherwise fall back to the full eager-load walk.
        if (page === 0 && totalHits >= WIDGETS_PREFER_THRESHOLD) {
          try {
            const india = await fetchWidgetsPage(from);
            if (india.jobs.length > 0) {
              useWidgets = true;
              logger.info(
                { company: company.slug, boardTotal: totalHits, indiaTotal: india.totalHits },
                "phenom: large board, using the India-filtered widget XHR",
              );
              return { items: toItems(india.jobs), total: india.totalHits, rawCount: india.jobs.length };
            }
            const unfiltered = await fetchWidgetsPage2(from, false);
            if (unfiltered.jobs.length > 0) {
              logger.info(
                { company: company.slug, boardTotal: totalHits },
                "phenom: large board has zero India-tagged jobs (verified via widgets) - skipping the full walk",
              );
              return { items: [], total: 0 };
            }
          } catch (err) {
            logger.warn(
              { company: company.slug, err: describeError(err) },
              "phenom: widgets probe failed on a large board - falling back to the eager-load walk",
            );
          }
        }

        return { items: toItems(jobs), total: totalHits, rawCount: jobs.length };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (!company.tenantUrl) throw new Error(`phenom requires tenant_url (search URL) for ${company.slug}`);
    const url = phenomJobPageUrl(company.tenantUrl, posting.externalId);
    const html = await atsFetchText(url, { provider: "phenom" });
    const ddo = extractPhenomDdo(html);
    const description = phenomJobDescriptionFrom(ddo);
    if (description === null) {
      throw new Error(`phenom: no jobDetail description at ${url} for ${company.slug}`);
    }
    return htmlToText(description);
  },
};
