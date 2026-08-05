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
//
// company_uuid is a FILTER on a shared API, not a tenant address, and an unknown
// value is not rejected — it just matches nothing, so a dead tenant answers
// exactly like a live board with nothing open. The one endpoint that resolves the
// tenant itself is the board page's own SSR payload, consulted only on that
// zero-row path — see assertPyjamahrTenantExists.
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
// `next`-chasing needs its own page cap (the shared offset paginator doesn't fit
// URL-cursor pagination); 1000 pages x 10/page is far beyond any tenant seen.
const MAX_PAGES = 1000;

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
export function parsePyjamahrList(json: JsonValue): PyjamahrList {
  return PyjamahrListSchema.parse(json);
}

// --- tenant existence ---------------------------------------------------------

/** The board page whose getServerSideProps resolves company_uuid to a tenant.
 *  The ?company= display param has to be present for the SSR to run at all (with
 *  company_uuid alone the page ships no __NEXT_DATA__), though its VALUE is not
 *  checked — a live uuid resolves under a deliberately wrong name. */
export function pyjamahrBoardPageUrl(company: AdapterCompany, uuid: string): string {
  const params = `company=${encodeURIComponent(pyjamahrBoardParam(company))}&company_uuid=${encodeURIComponent(uuid)}`;
  return `${BOARD_ORIGIN}/careers?${params}`;
}

// Either the tenant resolved (companyDetails, with its name) or the SSR's own
// lookup failed (error). Both keys optional: any other shape is inconclusive and
// must not fail the company.
const BoardPagePropsSchema = z.object({
  props: z.object({
    pageProps: z.object({
      companyDetails: z.object({ name: z.string() }).nullable().optional(),
      error: z.string().nullable().optional(),
    }),
  }),
});

/** Three-valued: the tenant resolves, the vendor says it does not exist, or the
 *  probe told us nothing (and must therefore change nothing). */
export type PyjamahrTenantVerdict = "resolves" | "absent" | "inconclusive";

/**
 * Read the board page's `__NEXT_DATA__` island and say whether company_uuid
 * resolved to a tenant.
 *
 * "absent" is reserved for the one shape a nonexistent tenant produces: no
 * companyDetails AND an error from the SSR's own lookup. Anything else — a
 * missing island, unparseable JSON, an unexpected shape — is "inconclusive",
 * because the list call already succeeded and an oddity here says nothing about
 * the tenant.
 */
export function pyjamahrTenantVerdict(html: string): PyjamahrTenantVerdict {
  const island = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (island === undefined) return "inconclusive";
  const parsed = BoardPagePropsSchema.safeParse(tryParseJson(island));
  if (!parsed.success) return "inconclusive";
  const pageProps = parsed.data.props.pageProps;
  if (pageProps.companyDetails) return "resolves";
  return pageProps.error ? "absent" : "inconclusive";
}

/**
 * Throw when the tenant behind api_meta.companyUuid does not exist.
 *
 * company_uuid is a filter on a shared API rather than a tenant address, and the
 * list endpoint does not reject an unknown value: probed 2026-08-03,
 * ZZZZZZZZZZ, 0000000000, acmewidgetsco and "" each returned HTTP 200
 * {"count":0,"next":null,"previous":null,"results":[]} — byte-identical to a live
 * tenant whose board is empty. So a dead uuid sat green forever, and no amount of
 * inspecting the list response could tell the two apart.
 *
 * The board page can, because its getServerSideProps resolves the uuid to a
 * company: all 7 live rows come back with props.pageProps.companyDetails naming
 * the employer (Zinance, Bynry, F Jobs by Fashion TV India, Kuku FM, Masai,
 * Neusort, smallcase), while every bogus uuid comes back with
 * props.pageProps.error and no companyDetails.
 *
 * Consulted ONLY when page 1 returned zero rows, so a board that produced
 * postings never pays for the extra request and can never be failed by it. And
 * only a definitive "the vendor's own lookup 404ed" verdict fails the company —
 * a transport failure, an HTTP error or an unrecognised payload leaves the empty
 * result standing, exactly as it does today. A tenant whose board empties out
 * still resolves, so it keeps returning [].
 *
 * The cheaper JSON candidate was rejected: /api/career/jobs/departments is a
 * tenant master list (fashiontv returns 89 departments against 20 open jobs) and
 * so looks independent of the board, but it is still derived data — neusort has
 * exactly one department — and a tenant that never named one would be
 * indistinguishable from a dead uuid.
 */
export async function assertPyjamahrTenantExists(company: AdapterCompany, uuid: string): Promise<void> {
  let verdict: PyjamahrTenantVerdict;
  try {
    const html = await atsFetchText(pyjamahrBoardPageUrl(company, uuid), { provider: "pyjamahr" });
    verdict = pyjamahrTenantVerdict(html);
  } catch (err) {
    // The list call already succeeded; a failure on this confirmation probe is
    // evidence about the probe, not about the tenant.
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

    // The loop only exits with url still non-null by exhausting MAX_PAGES
    // (the natural-completion path sets url to null via parsed.next first) —
    // this is the runaway-cap-truncation case, worth a loud warning.
    if (url !== null && page === MAX_PAGES) {
      logger.warn(
        { slug: company.slug, maxPages: MAX_PAGES },
        "pyjamahr pagination hit the runaway cap - board may be truncated"
      );
    }

    // Zero rows is the one outcome an unknown company_uuid also produces, so it
    // is the only one worth a second request — see assertPyjamahrTenantExists.
    if (out.length === 0) await assertPyjamahrTenantExists(company, uuid);

    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const uuid = pyjamahrCompanyUuid(company);
    const raw = await atsFetchJson(pyjamahrJdUrl(uuid, posting.externalId), { provider: "pyjamahr" });
    return htmlToText(parsePyjamahrDetail(raw) ?? "");
  },
};
