// src/ats/sfcsb.ts — SAP SuccessFactors CSB (Career Site Builder) JSON API; distinct from successfactors.ts, which scrapes the legacy jobs2web HTML board.
// List: POST <host>/services/recruiting/v1/jobs (0-based pageNumber, page size fixed at 10, sortBy "date"; India cut done by the pipeline's location filter). JD: GET <host>/job/<slug>/<id>-<locale>/ for CSB ids or /job/<slug>/<id>/ for jobs2web req ids; richest itemprop="description" span, else joblayouttoken value.
import { z } from "zod";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import { fetchSfSitemapIds, sitemapOnlyEntries, titleFromSitemapUrl } from "./sfSitemap.js";
import type { JsonValue } from "../util/json.js";

const PAGE = 10; // server-fixed
const LOCALE = "en_US";

const MONTHS_MDY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;

/** Parse the CSB "M/D/YY" start date to a UTC-midnight ISO (timezone-stable). */
export function sfcsbDate(s: string | null | undefined): string | null {
  const m = MONTHS_MDY_RE.exec((s ?? "").trim());
  if (!m) return null;
  const year = 2000 + Number(m[3]);
  return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]))).toISOString();
}

const SfcsbJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  unifiedStandardTitle: z.string(),
  urlTitle: z.string().nullable().optional(),
  unifiedStandardStart: z.string().nullable().optional(),
  jobLocationShort: z.array(z.string()).nullable().optional(),
  custprimecity: z.string().nullable().optional(),
  custCountryRegion: z.array(z.string()).nullable().optional(),
});
const SfcsbResponseSchema = z.object({
  totalJobs: z.number().nullable().optional(),
  jobSearchResult: z.array(z.object({ response: SfcsbJobSchema })).nullable().optional(),
});

/** POST body for a 0-based page; the default relevance sort reshuffles ties between requests (tuv-sud: 302 unique of 381) while "date" is stable. Locale is a TENANT setting (indegene needs en_GB) - apiMeta.locale overrides. */
export function sfcsbSearchBody(pageNumber: number, locale: string = LOCALE): JsonValue {
  return { keywords: "", locale, pageNumber, sortBy: "date" };
}

/** Canonical public job URL for a CSB id; the slug segment is cosmetic. */
export function sfcsbJobUrl(company: AdapterCompany, id: string, slug: string | null | undefined): string {
  const seg = slug !== undefined && slug !== null && slug !== "" ? slug : "x";
  const locale = company.apiMeta?.locale ?? LOCALE;
  return `${tenantOrigin(company)}/job/${seg}/${id}-${locale}/`;
}

/** The jobs2web req-id form of a sfcsbJobUrl (drops the -<locale> suffix); on req-id tenants the suffixed form can redirect-loop (indegene). */
export function sfcsbReqIdJobUrl(csbJobUrl: string): string {
  return csbJobUrl.replace(/\/(\d+)-[A-Za-z]{2}_[A-Za-z]{2}\/$/, "/$1/");
}

function sfcsbLocation(j: z.infer<typeof SfcsbJobSchema>): string | null {
  if (j.jobLocationShort && j.jobLocationShort.length > 0) {
    return j.jobLocationShort.map((s) => s.trim()).filter((s) => s !== "").join("; ") || null;
  }
  const parts = [j.custprimecity, j.custCountryRegion?.[0]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Parse one page into postings + the totalJobs count (jdText filled by fetchJd). */
export function parseSfcsbPage(
  raw: JsonValue,
  company: AdapterCompany,
): { jobs: NormalizedPosting[]; total: number | null } {
  const page = parseOrThrow(SfcsbResponseSchema, raw, { provider: "sfcsb", slug: company.slug });
  const jobs = (page.jobSearchResult ?? []).map(({ response: j }) => {
    const location = sfcsbLocation(j);
    return {
      provider: "sfcsb" as const,
      externalId: j.id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: j.unifiedStandardTitle,
      jobUrl: sfcsbJobUrl(company, j.id, j.urlTitle),
      location,
      isRemote: REMOTE_RE.test(`${location ?? ""} ${j.unifiedStandardTitle}`),
      jdText: "",
      postedAt: sfcsbDate(j.unifiedStandardStart),
    };
  });
  return { jobs, total: page.totalJobs ?? null };
}

/** Placeholder posting for a sitemap id the JSON listing never returned: jobUrl is the sitemap's own canonical URL, title is derived from its slug segment, location stays null (the pipeline's late location check handles that), jdText is filled by fetchJd like every other posting. */
function sfcsbPostingFromSitemap(company: AdapterCompany, id: string, url: string): NormalizedPosting {
  const jobTitle = titleFromSitemapUrl(url);
  return {
    provider: "sfcsb",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle,
    jobUrl: url,
    location: null,
    isRemote: REMOTE_RE.test(jobTitle),
    jdText: "",
    postedAt: null,
  };
}

function richestText($: cheerio.CheerioAPI, selector: string): string {
  let best = "";
  $(selector).each((_i, el) => {
    const text = htmlToText($(el).html() ?? "");
    if (text.length > best.length) best = text;
  });
  return best;
}

/** Extract the JD from a CSB job page: the richest itemprop="description" span, else (req-id pages carry no itemprop) the richest joblayouttoken value. */
export function parseSfcsbJd(html: string): string {
  const $ = cheerio.load(html);
  const described = richestText($, "span[itemprop=description]");
  return described !== "" ? described : richestText($, ".joblayouttoken span.rtltextaligneligible");
}

export const sfcsbAdapter: AtsAdapter = {
  provider: "sfcsb",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // CSB pagination order is unstable (jobs recur, pages can fully repeat, totalJobs can be inflated) - don't hand dedupeBy to paginate since its stall guard would break on the first repeat page; walk to the natural empty page and dedupe here instead.
    const raw = await paginate<NormalizedPosting>({
      provider: "sfcsb",
      company: company.slug,
      pageSize: PAGE,
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(`${tenantOrigin(company)}/services/recruiting/v1/jobs`, {
          method: "POST",
          body: sfcsbSearchBody(page, company.apiMeta?.locale ?? undefined),
          provider: "sfcsb",
        });
        const { jobs, total } = parseSfcsbPage(json, company);
        return { items: jobs, total };
      },
    });
    const seen = new Set<string>();
    const out: NormalizedPosting[] = [];
    for (const p of raw) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    const apiCount = out.length;

    // Completeness backstop, valid only when the API speaks the sitemap's id space: tuv-sud's API returns CSB ids (5311) while its sitemap lists jobs2web req ids (1350177555) for the SAME jobs.
    const sitemapIds = await fetchSfSitemapIds(company, "sfcsb");
    let gapFilled = 0;
    if (sitemapIds) {
      if (apiCount > 0 && !out.some((p) => sitemapIds.has(p.externalId))) {
        logger.info({ slug: company.slug, api: apiCount, sitemap: sitemapIds.size }, "sfcsb: sitemap lists a different id space than the API, gap-fill skipped");
      } else {
        for (const p of out) p.jobUrl = sitemapIds.get(p.externalId) ?? sfcsbReqIdJobUrl(p.jobUrl);
        for (const [id, url] of sitemapOnlyEntries(sitemapIds, seen, { slug: company.slug, provider: "sfcsb" })) {
          out.push(sfcsbPostingFromSitemap(company, id, url));
          gapFilled++;
        }
      }
    }
    logger.info(
      { slug: company.slug, api: apiCount, sitemap: sitemapIds?.size ?? 0, gapFilled },
      `sfcsb ${company.slug}: api=${apiCount} sitemap=${sitemapIds?.size ?? 0} gapFilled=${gapFilled}`,
    );
    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "sfcsb" });
    const jd = parseSfcsbJd(html);
    if (jd === "") {
      logger.warn({ company: company.slug, job: posting.externalId }, "sfcsb: job page had no description content");
    }
    return jd;
  },
};
