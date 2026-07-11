// src/ats/pyjamahr.ts — PyjamaHR career boards (app.pyjamahr.com/careers?company=<slug>
// &company_uuid=<uuid>), e.g. smallcase, Increff, Zinance. The board SPA is backed by
// a public, unauthenticated DRF API keyed by the tenant's company_uuid
// (registry: api_meta.companyUuid):
//
//   list: GET https://api.pyjamahr.com/api/career/jobs/?company_uuid=<uuid>&page=<N>&is_careers_page=true
//         -> { count, next, previous, results: [{ id, slug, title, location,
//              other_locations, country, workplace_type, ... }] }
//         10 per page; paginate by following `next` until null (NEVER truncate).
//
//   jd:   GET https://api.pyjamahr.com/api/career/jobs/<id>/?company_uuid=<uuid>
//         -> { id, uuid, title, job_type, description: "<p>...HTML..." }
//         The list payload has no description, so the JD comes from fetchJd.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";

const API_ORIGIN = "https://api.pyjamahr.com";
const BOARD_ORIGIN = "https://app.pyjamahr.com";
// `next`-chasing needs its own page cap (the shared offset paginator doesn't fit
// URL-cursor pagination); 200 pages x 10/page is far beyond any tenant seen.
const MAX_PAGES = 200;

// other_locations has only been observed empty ([]); accept strings or {name}/{city}
// objects so a non-empty tenant can't fail the whole listing on shape.
const OtherLocationSchema = z.union([
  z.string(),
  z.object({ name: z.string().nullable().optional(), city: z.string().nullable().optional() }),
]);

export const PyjamahrJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string().nullable().optional(),
  title: z.string(),
  min_experience: z.number().nullable().optional(),
  max_experience: z.number().nullable().optional(),
  country: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  other_locations: z.array(OtherLocationSchema).nullable().optional(),
  department_name: z.string().nullable().optional(),
  workplace_type: z.string().nullable().optional(),
});
export type PyjamahrJob = z.infer<typeof PyjamahrJobSchema>;

const PyjamahrListSchema = z.object({
  count: z.number(),
  next: z.string().nullable(),
  results: z.array(PyjamahrJobSchema),
});
export type PyjamahrList = z.infer<typeof PyjamahrListSchema>;

const PyjamahrDetailSchema = z.object({
  description: z.string().nullable().optional(),
});

/** Tenant identity: api_meta.companyUuid. Throws when unset — the API is unusable without it. */
export function pyjamahrCompanyUuid(company: AdapterCompany): string {
  const uuid = company.apiMeta?.["companyUuid"];
  if (!uuid) throw new Error(`pyjamahr requires api_meta.companyUuid for ${company.slug}`);
  return uuid;
}

/** Listing page URL (1-based). */
export function pyjamahrListUrl(uuid: string, page: number): string {
  return `${API_ORIGIN}/api/career/jobs/?company_uuid=${encodeURIComponent(uuid)}&page=${page}&is_careers_page=true`;
}

/** Detail (JD) URL for one job id. */
export function pyjamahrJdUrl(uuid: string, jobId: string): string {
  return `${API_ORIGIN}/api/career/jobs/${encodeURIComponent(jobId)}/?company_uuid=${encodeURIComponent(uuid)}`;
}

/** The board's ?company= display slug — taken from the registry careersUrl when
 *  present (it's part of the canonical board link), else the company slug. */
export function pyjamahrBoardParam(company: AdapterCompany): string {
  try {
    const fromUrl = new URL(company.careersUrl).searchParams.get("company");
    if (fromUrl) return fromUrl;
  } catch {
    /* fall through */
  }
  return company.slug;
}

/** Human-facing deep link into the board SPA for one job. */
export function pyjamahrJobUrl(company: AdapterCompany, j: PyjamahrJob): string {
  const uuid = pyjamahrCompanyUuid(company);
  const seg = j.slug ?? String(j.id);
  const params = `company=${encodeURIComponent(pyjamahrBoardParam(company))}&company_uuid=${encodeURIComponent(uuid)}`;
  return `${BOARD_ORIGIN}/careers/${encodeURIComponent(seg)}?${params}`;
}

/** location + other_locations + country, deduped; country only when no part already names it. */
export function pyjamahrLocation(j: PyjamahrJob): string | null {
  const parts: string[] = [];
  const push = (s: string | null | undefined): void => {
    const t = (s ?? "").trim();
    if (t && !parts.includes(t)) parts.push(t);
  };
  push(j.location);
  for (const ol of j.other_locations ?? []) {
    push(typeof ol === "string" ? ol : ol.name ?? ol.city);
  }
  const country = (j.country ?? "").trim();
  if (country && !parts.some((p) => p.toLowerCase().includes(country.toLowerCase()))) {
    parts.push(country);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Unwrap + validate one DRF list page. Throws on shape mismatch. */
export function parsePyjamahrList(json: unknown): PyjamahrList {
  return PyjamahrListSchema.parse(json);
}

/** Pull the HTML description from a detail response. Null when absent. */
export function parsePyjamahrDetail(json: unknown): string | null {
  const parsed = PyjamahrDetailSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.description ?? null;
}

export function normalizePyjamahr(company: AdapterCompany, j: PyjamahrJob): NormalizedPosting {
  const location = pyjamahrLocation(j);
  const workplace = j.workplace_type ?? "";
  return {
    provider: "pyjamahr",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: pyjamahrJobUrl(company, j),
    location,
    isRemote: /^remote$/i.test(workplace) || (location !== null && REMOTE_RE.test(location)),
    jdText: "", // list payload has no description; fetchJd fills it
    postedAt: null, // API exposes no posting date
  };
}

export const pyjamahrAdapter: AtsAdapter = {
  provider: "pyjamahr",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const uuid = pyjamahrCompanyUuid(company);
    const out: NormalizedPosting[] = [];
    let url: string | null = pyjamahrListUrl(uuid, 1);

    for (let page = 0; url !== null && page < MAX_PAGES; page++) {
      const raw = await atsFetchJson(url, { provider: "pyjamahr" });
      let parsed: PyjamahrList;
      try {
        parsed = parsePyjamahrList(raw);
      } catch (err) {
        logger.warn({ slug: company.slug, page: page + 1, err: String(err) }, "pyjamahr list schema mismatch");
        throw new Error(`pyjamahr: unexpected list response shape for ${company.slug} (page ${page + 1})`);
      }
      for (const j of parsed.results) out.push(normalizePyjamahr(company, j));

      url = parsed.next;
      if (url !== null) {
        warnDeepPagination("pyjamahr", company.slug, page + 1, out.length);
        await sleep(INTER_PAGE_DELAY_MS);
      }
    }

    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const uuid = pyjamahrCompanyUuid(company);
    const raw = await atsFetchJson(pyjamahrJdUrl(uuid, posting.externalId), { provider: "pyjamahr" });
    return htmlToText(parsePyjamahrDetail(raw) ?? "");
  },
};
