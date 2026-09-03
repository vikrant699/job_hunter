// src/ats/ongig.ts — Ongig-powered careers sites (e.g. jobs.yum.com) proxy Elastic App Search behind a Laravel front end that pins the search call to a per-session XSRF token.
// GET the origin for the XSRF-TOKEN cookie, then POST /api/appSearch with x-xsrf-token + cookie headers.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { parseOrThrow, withAtsTimeout } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const PAGE = 10;

const RawStr = z.object({ raw: z.union([z.string(), z.number()]).nullable().optional() }).nullable().optional();

export const OngigResultSchema = z.object({
  title: RawStr,
  location: RawStr,
  req_id: RawStr,
  url: RawStr,
  country_filter: RawStr,
  content: RawStr,
});
export type OngigResult = z.infer<typeof OngigResultSchema>;

export const OngigResponseSchema = z.object({
  meta: z.object({
    page: z.object({
      current: z.number(),
      total_pages: z.number().nullable().optional(),
      total_results: z.number().nullable().optional(),
    }),
  }),
  results: z.array(OngigResultSchema),
});

function raw(v: { raw?: string | number | null | undefined } | null | undefined): string | null {
  const r = v?.raw;
  if (typeof r === "string") return r.trim() || null;
  if (typeof r === "number") return String(r);
  return null;
}

function groupId(company: AdapterCompany): string {
  const g = company.apiMeta?.groupId;
  if (!g) throw new Error(`ongig requires apiMeta.groupId for ${company.slug}`);
  return g;
}

export function ongigBody(groupId: string, countryFilter: string, current: number): JsonValue {
  return {
    query: "",
    result_fields: {
      title: { raw: {} },
      location: { raw: {} },
      req_id: { raw: {} },
      url: { raw: {} },
      country_filter: { raw: {} },
      content: { raw: {} },
    },
    page: { size: PAGE, current },
    filters: {
      all: [
        { any: [{ group_id: Number(groupId) }] },
        { any: [{ live: 1 }] },
        { any: [{ pcu: 0 }] },
        { any: [{ country_filter: countryFilter }] },
      ],
    },
  };
}

export function normalizeOngig(company: AdapterCompany, org: string, r: OngigResult): NormalizedPosting | null {
  const title = raw(r.title);
  if (!title) return null;
  const reqId = raw(r.req_id) ?? title;
  const location = raw(r.location) ?? raw(r.country_filter);
  const path = raw(r.url);
  let jobUrl = company.tenantUrl ?? company.careersUrl;
  if (path) {
    try { jobUrl = new URL(path, org).toString(); } catch { /* keep board url */ }
  }
  return {
    provider: "ongig",
    externalId: reqId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: (raw(r.content) ?? "").trim(), // requesting content.raw (not the truncated snippet field) yields the full JD
    postedAt: null,
  };
}

// Raw fetch (not atsFetchJson/atsFetchHtml): needs the actual Response to read getSetCookie().
async function ongigSession(org: string): Promise<{ token: string; cookie: string }> {
  const res = await withAtsTimeout((signal) => fetch(`${org}/`, { headers: { "user-agent": BROWSER_UA }, signal }));
  const setCookies = res.headers.getSetCookie();
  const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  const xsrf = setCookies.find((c) => c.startsWith("XSRF-TOKEN="));
  const token = xsrf ? decodeURIComponent(xsrf.slice("XSRF-TOKEN=".length).split(";")[0] ?? "") : "";
  if (!token) throw new Error("ongig: no XSRF-TOKEN cookie on board root");
  return { token, cookie };
}

export const ongigAdapter: AtsAdapter = {
  provider: "ongig",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const org = tenantOrigin(company);
    const gid = groupId(company);
    const countryFilter = company.apiMeta?.countryFilter ?? "india";
    const { token, cookie } = await ongigSession(org);

    return paginate<NormalizedPosting>({
      provider: "ongig",
      company: company.slug,
      pageSize: PAGE,
      // Termination is a zero-result page or reaching meta.page.total_pages (re-read every response).
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, page) => {
        const current = page + 1; // API is 1-based
        // Raw fetch: needs the bespoke cookie/xsrf-token headers from the session handshake above.
        const res = await withAtsTimeout((signal) =>
          fetch(`${org}/api/appSearch`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "x-xsrf-token": token,
              cookie,
              referer: `${org}/`,
              "user-agent": BROWSER_UA,
            },
            body: JSON.stringify(ongigBody(gid, countryFilter, current)),
            signal,
          }),
        );
        if (!res.ok) throw new Error(`ongig HTTP ${res.status} for ${company.slug}`);
        const parsed = parseOrThrow(OngigResponseSchema, JsonValueSchema.parse(await res.json()), {
          provider: "ongig",
          slug: company.slug,
          what: `list p${current}`,
        });
        const items = parsed.results
          .map((r) => normalizeOngig(company, org, r))
          .filter((p): p is NormalizedPosting => p !== null);
        // total_pages is re-read from this page's own response; report a total equal to the cumulative offset once this is the last page, null otherwise, so the loop stops right after.
        const totalPagesNow = parsed.meta.page.total_pages ?? current;
        const isLastPage = current >= totalPagesNow;
        return {
          items,
          rawCount: parsed.results.length,
          total: isLastPage ? offset + parsed.results.length : null,
        };
      },
    });
  },
};
