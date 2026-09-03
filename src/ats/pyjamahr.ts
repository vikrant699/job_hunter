// src/ats/pyjamahr.ts — PyjamaHR career boards (app.pyjamahr.com/careers?company=<slug>&company_uuid=<uuid>): a public unauthenticated DRF API keyed by company_uuid (api_meta.companyUuid), list paginated via `next` (10/page).
// The JD comes from a separate per-job GET; see assertPyjamahrTenantExists for why an unknown company_uuid looks like an empty live board rather than an error.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const API_ORIGIN = "https://api.pyjamahr.com";
const BOARD_ORIGIN = "https://app.pyjamahr.com";
// `next`-chasing needs its own page cap (the shared offset paginator doesn't fit URL-cursor pagination); 1000 pages x 10/page is far beyond any tenant seen.
const MAX_PAGES = 1000;

// other_locations has only been observed empty ([]); accept strings or {name}/{city} objects so a non-empty tenant can't fail the whole listing on shape.
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

export function pyjamahrCompanyUuid(company: AdapterCompany): string {
  const uuid = company.apiMeta?.["companyUuid"];
  if (!uuid) throw new Error(`pyjamahr requires api_meta.companyUuid for ${company.slug}`);
  return uuid;
}

// 1-based page.
export function pyjamahrListUrl(uuid: string, page: number): string {
  return `${API_ORIGIN}/api/career/jobs/?company_uuid=${encodeURIComponent(uuid)}&page=${page}&is_careers_page=true`;
}

export function pyjamahrJdUrl(uuid: string, jobId: string): string {
  return `${API_ORIGIN}/api/career/jobs/${encodeURIComponent(jobId)}/?company_uuid=${encodeURIComponent(uuid)}`;
}

// The board's ?company= display slug — taken from the registry careersUrl when present, else the slug.
export function pyjamahrBoardParam(company: AdapterCompany): string {
  try {
    const fromUrl = new URL(company.careersUrl).searchParams.get("company");
    if (fromUrl) return fromUrl;
  } catch {
    /* fall through */
  }
  return company.slug;
}

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
export function parsePyjamahrList(json: JsonValue): PyjamahrList {
  return PyjamahrListSchema.parse(json);
}

// ?company= must be present for the SSR to run at all (company_uuid alone ships no __NEXT_DATA__), though its value isn't checked — a live uuid resolves under a deliberately wrong name.
export function pyjamahrBoardPageUrl(company: AdapterCompany, uuid: string): string {
  const params = `company=${encodeURIComponent(pyjamahrBoardParam(company))}&company_uuid=${encodeURIComponent(uuid)}`;
  return `${BOARD_ORIGIN}/careers?${params}`;
}

// Either the tenant resolved (companyDetails) or the SSR's own lookup failed (error); any other shape is inconclusive and must not fail the company.
const BoardPagePropsSchema = z.object({
  props: z.object({
    pageProps: z.object({
      companyDetails: z.object({ name: z.string() }).nullable().optional(),
      error: z.string().nullable().optional(),
    }),
  }),
});

export type PyjamahrTenantVerdict = "resolves" | "absent" | "inconclusive";

// "absent" is reserved for the one shape a nonexistent tenant produces (no companyDetails AND an SSR lookup error); anything else is "inconclusive" since the list call already succeeded.
export function pyjamahrTenantVerdict(html: string): PyjamahrTenantVerdict {
  const island = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (island === undefined) return "inconclusive";
  const parsed = BoardPagePropsSchema.safeParse(tryParseJson(island));
  if (!parsed.success) return "inconclusive";
  const pageProps = parsed.data.props.pageProps;
  if (pageProps.companyDetails) return "resolves";
  return pageProps.error ? "absent" : "inconclusive";
}

// company_uuid is a filter on a shared API, not a tenant address: an unknown value returns HTTP 200 {"count":0} identical to a live empty board, so the list response alone can't tell a dead uuid from a real empty one.
// The board page's own SSR can tell (it resolves the uuid to a company name); consulted only when page 1 returned zero rows.
// Only a definitive "vendor lookup 404ed" verdict fails the company — a transport failure or unrecognised payload leaves the empty result as-is.
export async function assertPyjamahrTenantExists(company: AdapterCompany, uuid: string): Promise<void> {
  let verdict: PyjamahrTenantVerdict;
  try {
    const html = await atsFetchText(pyjamahrBoardPageUrl(company, uuid), { provider: "pyjamahr" });
    verdict = pyjamahrTenantVerdict(html);
  } catch (err) {
    // A failure on this confirmation probe is evidence about the probe, not about the tenant.
    logger.warn({ slug: company.slug, err: String(err) }, "pyjamahr tenant-existence probe failed - leaving the empty board as-is");
    return;
  }
  if (verdict !== "absent") return;

  throw new Error(
    `pyjamahr: tenant does not exist — company_uuid ${uuid} resolves to no company on the board ` +
      `page for ${company.slug}, and the list endpoint silently matches nothing for an unknown ` +
      `uuid, so the board is dead rather than empty.`,
  );
}

/** Pull the HTML description from a detail response. Null when absent. */
export function parsePyjamahrDetail(json: JsonValue): string | null {
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
    let page = 0;

    for (; url !== null && page < MAX_PAGES; page++) {
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

    // url still non-null here means the loop exhausted MAX_PAGES rather than completing naturally.
    if (url !== null && page === MAX_PAGES) {
      logger.warn(
        { slug: company.slug, maxPages: MAX_PAGES },
        "pyjamahr pagination hit the runaway cap - board may be truncated"
      );
    }

    if (out.length === 0) await assertPyjamahrTenantExists(company, uuid);

    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const uuid = pyjamahrCompanyUuid(company);
    const raw = await atsFetchJson(pyjamahrJdUrl(uuid, posting.externalId), { provider: "pyjamahr" });
    return htmlToText(parsePyjamahrDetail(raw) ?? "");
  },
};
