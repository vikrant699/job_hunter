// src/ats/ongig.ts — Ongig-powered careers sites (e.g. jobs.yum.com for Yum!
// Brands India). Ongig proxies Elastic App Search behind a Laravel front end
// that pins the search call to a per-session XSRF token:
//
//   1. GET  <origin>/            -> Set-Cookie: XSRF-TOKEN (+ session cookie)
//   2. POST <origin>/api/appSearch
//        headers: x-xsrf-token: <decoded XSRF-TOKEN cookie>, cookie: <jar>
//        body:   { query, result_fields, page:{size,current},
//                  filters:{ all:[ {any:[{group_id}]}, {any:[{live:1}]},
//                                  {any:[{pcu:0}]}, {any:[{country_filter}]} ] } }
//     -> { meta:{ page:{ current,total_pages,total_results } },
//          results:[{ title:{raw}, location:{raw}, req_id:{raw}, url:{raw},
//                     country_filter:{raw}, content:{raw} }] }
//
// apiMeta.groupId selects the tenant board; apiMeta.countryFilter (default
// "india") scopes to India — verified live on Yum (group_id 1583, 16 India
// jobs, full JD inline in content.raw). Paged by page.current until
// total_pages. Requesting content.raw (not the truncated snippet) yields the
// full JD.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { parseOrThrow } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep } from "./shared.js";

const PAGE = 10;
const MAX_PAGES = 100;

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

function raw(v: { raw?: string | number | null } | null | undefined): string | null {
  const r = v?.raw;
  if (typeof r === "string") return r.trim() || null;
  if (typeof r === "number") return String(r);
  return null;
}

function origin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

function groupId(company: AdapterCompany): string {
  const g = company.apiMeta?.groupId;
  if (!g) throw new Error(`ongig requires apiMeta.groupId for ${company.slug}`);
  return g;
}

export function ongigBody(groupId: string, countryFilter: string, current: number): unknown {
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
    jdText: (raw(r.content) ?? "").trim(),
    postedAt: null,
  };
}

/** GET the board root to obtain the XSRF-TOKEN cookie; returns { token, cookie }. */
async function ongigSession(org: string): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${org}/`, { headers: { "user-agent": BROWSER_UA } });
  // Node fetch folds multiple Set-Cookie into getSetCookie().
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
    const org = origin(company);
    const gid = groupId(company);
    const countryFilter = company.apiMeta?.countryFilter ?? "india";
    const { token, cookie } = await ongigSession(org);

    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    let totalPages = 1;

    for (let current = 1; current <= Math.min(totalPages, MAX_PAGES); current++) {
      const res = await fetch(`${org}/api/appSearch`, {
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
      });
      if (!res.ok) throw new Error(`ongig HTTP ${res.status} for ${company.slug}`);
      const parsed = parseOrThrow(OngigResponseSchema, await res.json(), {
        provider: "ongig",
        slug: company.slug,
        what: `list p${current}`,
      });
      totalPages = parsed.meta.page.total_pages ?? current;
      for (const r of parsed.results) {
        const p = normalizeOngig(company, org, r);
        if (!p || seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      if (parsed.results.length === 0) break;
      if (current < totalPages) await sleep(INTER_PAGE_DELAY_MS);
    }

    return out;
  },
};
