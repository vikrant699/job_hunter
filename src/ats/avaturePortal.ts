// list: GET <origin>/<portalId>/_portalList?<the SearchJobs page's <list data-props> config + its session-bound qtvc>&offset=N, sent with that page's session cookie (else "This list is private")
// jd: inline in the list's Description column; otherwise the server-rendered JobDetail page (parseAvatureJd)
import * as cheerio from "cheerio";
import { z } from "zod";
import { config } from "../config.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema, tryParseJson } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsHttpError, parseOrThrow, withAtsTimeout } from "./http.js";
import { DEFAULT_MAX_PAGES, REMOTE_RE, collapseWs, dateToIso, paginate } from "./shared.js";

const PAGE_SIZE = 100; // SanDisk's engine clamps to 50; paginate infers the real size from page one
const LOCATION_LABEL_RE = /^(city|town|state|state\/region|province|region|country|country\/region|location|job location|work location)$/i;
const WORK_MODE_LABEL_RE = /work\s*mode|workplace|remote/i;
const REMOTE_MODE_RE = /\bremote(ly)?\b|from home/i;
const DESCRIPTION_LABEL_RE = /description/i;

const ListPropsSchema = z.object({
  uuid: z.string(),
  listType: z.string(),
  qtvc: z.string(),
  hasToIncludePaginationOptions: z.boolean().nullish(),
  allowListSorting: z.boolean().nullish(),
  fetchJobIdInPeopleLists: z.boolean().nullish(),
  allowFilteringFromUrlParams: z.boolean().nullish(),
  shouldAddBase64FileFields: z.boolean().nullish(),
  layout: z.string().nullish(),
  searchMode: z.string().nullish(),
  formId: z.string().nullish(),
  searchIndexId: z.union([z.number(), z.string()]).nullish(),
  links: JsonValueSchema.optional(),
  dynamicValueConfigs: JsonValueSchema.optional(),
});
type ListProps = z.infer<typeof ListPropsSchema>;

export interface AvaturePortalPage {
  portalId: string;
  props: ListProps;
}

const FieldSchema = z.object({ htmlValue: z.string().nullish(), stringValue: z.string().nullish() });
const ResultSchema = z.object({
  id: z.union([z.number(), z.string()]),
  fields: z.record(FieldSchema.nullable()),
});
const ListResponseSchema = z.object({
  results: z.array(ResultSchema),
  total: z.union([z.string(), z.number()]).nullish(),
  columns: z.array(z.object({ id: z.number().nullish(), code: z.string(), label: z.string().nullish() })).nullish(),
  dropzones: z.array(z.object({ code: z.string(), columns: z.array(z.number()) })).nullish(),
  links: z.array(z.object({ detailPage: z.string().nullish(), jobDetailUrlCode: z.string().nullish() }).nullable()).nullish(),
});
type ListResponse = z.infer<typeof ListResponseSchema>;
type Field = z.infer<typeof FieldSchema>;

export function parseAvaturePortalPage(html: string): AvaturePortalPage | null {
  const $ = cheerio.load(html);
  const portalId = $('meta[name="avature.portal.id"]').attr("content")?.trim();
  if (!portalId) return null;
  for (const el of $("list[data-props]").toArray()) {
    const raw = $(el).attr("data-props");
    const json = raw ? tryParseJson(raw) : null;
    if (json === null) continue;
    const parsed = ListPropsSchema.safeParse(json);
    if (parsed.success && parsed.data.listType === "JobList") return { portalId, props: parsed.data };
  }
  return null;
}

function flag(v: boolean | null | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

// qtvc signs the widget config, so every param the portal's own list.js sends is mirrored verbatim; dropping one answers 403 "private"
export function avaturePortalListUrl(origin: string, page: AvaturePortalPage, offset: number, recordsPerPage: number): string {
  const p = page.props;
  const entries: Array<[string, string | null]> = [
    ["uuid", p.uuid],
    ["hasToIncludePaginationOptions", flag(p.hasToIncludePaginationOptions)],
    ["allowListSorting", flag(p.allowListSorting)],
    ["fetchJobIdInPeopleLists", flag(p.fetchJobIdInPeopleLists)],
    ["listType", p.listType],
    ["offset", String(offset)],
    ["filters", JSON.stringify({ search: "" })],
    ["sort", ""],
    ["sortDirection", "DESC"],
    ["recordsPerPage", String(recordsPerPage)],
    ["token", ""],
    ["allowFilteringFromUrlParams", flag(p.allowFilteringFromUrlParams)],
    ["layout", p.layout ?? null],
    ["dynamicValueConfigs", p.dynamicValueConfigs === undefined ? null : JSON.stringify(p.dynamicValueConfigs)],
    ["shouldAddBase64FileFields", flag(p.shouldAddBase64FileFields)],
    ["searchMode", p.searchMode ?? null],
    ["qtvc", p.qtvc],
    ["pageUrlParams", "{}"],
    ["links", p.links === undefined ? null : JSON.stringify(p.links)],
    ["formId", p.formId ?? null],
    ["searchIndexId", p.searchIndexId === null || p.searchIndexId === undefined ? null : String(p.searchIndexId)],
  ];
  const q = new URLSearchParams();
  for (const [k, v] of entries) if (v !== null) q.set(k, v);
  return `${origin}/${encodeURIComponent(page.portalId)}/_portalList?${q.toString()}`;
}

function fieldText(f: Field | null | undefined): string {
  if (!f) return "";
  const s = f.stringValue ? collapseWs(f.stringValue) : "";
  if (s) return s;
  return f.htmlValue ? collapseWs(htmlToText(f.htmlValue)) : "";
}

function columnCodes(list: ListResponse, labelRe: RegExp): string[] {
  return (list.columns ?? []).filter((c) => labelRe.test((c.label ?? "").trim())).map((c) => c.code);
}

function descriptionCodes(list: ListResponse): string[] {
  const dz = (list.dropzones ?? []).find((d) => d.code === "Description");
  const byZone = dz ? (list.columns ?? []).filter((c) => c.id !== null && c.id !== undefined && dz.columns.includes(c.id)).map((c) => c.code) : [];
  return byZone.length > 0 ? byZone : columnCodes(list, DESCRIPTION_LABEL_RE);
}

// links[] is index-aligned with results today; matching on the trailing id keeps a reordered array from cross-wiring URLs
function detailUrl(list: ListResponse, index: number, id: string, searchUrl: string): string {
  const links = list.links ?? [];
  const aligned = links[index];
  const ordered = aligned ? [aligned, ...links] : links;
  const candidates = ordered.flatMap((l) => (l ? [l.detailPage, l.jobDetailUrlCode] : []));
  const found = candidates.find((u) => !!u && (u.split(/[?#]/)[0] ?? "").replace(/\/+$/, "").endsWith(`/${id}`));
  if (found) return found;
  const u = new URL(searchUrl);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/SearchJobs\/?$/i, "").replace(/\/+$/, "") + `/JobDetail/${encodeURIComponent(id)}`;
  return u.toString();
}

export function parseAvaturePortalList(
  raw: JsonValue,
  company: AdapterCompany,
  searchUrl: string = company.tenantUrl ?? company.careersUrl,
): { postings: NormalizedPosting[]; total: number | null; rawCount: number } {
  const list = parseOrThrow(ListResponseSchema, raw, { provider: "avature", slug: company.slug });
  const locCodes = columnCodes(list, LOCATION_LABEL_RE);
  const modeCodes = columnCodes(list, WORK_MODE_LABEL_RE);
  const descCodes = descriptionCodes(list);
  const postings: NormalizedPosting[] = [];
  list.results.forEach((r, i) => {
    const f = r.fields;
    const id = String(r.id);
    const title = fieldText(f.name) || fieldText(f.nameWithoutLink);
    if (!title) return;
    const locParts: string[] = [];
    for (const code of locCodes) {
      const t = fieldText(f[code]);
      if (t && !locParts.includes(t)) locParts.push(t);
    }
    const location = locParts.length > 0 ? locParts.join(", ") : null;
    const mode = modeCodes.map((c) => fieldText(f[c])).join(" ");
    const jdText = descCodes
      .map((c) => {
        const html = f[c]?.htmlValue;
        return html ? htmlToText(html).trim() : fieldText(f[c]);
      })
      .filter(Boolean)
      .join("\n\n");
    postings.push({
      provider: "avature",
      externalId: id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: detailUrl(list, i, id, searchUrl),
      location,
      isRemote: REMOTE_RE.test(location ?? "") || REMOTE_MODE_RE.test(mode),
      jdText,
      postedAt: dateToIso(fieldText(f.postedDate)),
    });
  });
  const total = list.total === null || list.total === undefined ? null : Number(list.total);
  return { postings, total: total !== null && Number.isFinite(total) ? total : null, rawCount: list.results.length };
}

// Raw fetch (not atsFetchHtml): the list API only answers with the session cookie set by the same response that minted the qtvc.
async function portalSession(searchUrl: string): Promise<{ page: AvaturePortalPage; cookie: string; finalUrl: string }> {
  await awaitNetwork();
  const { html, cookie, finalUrl } = await withAtsTimeout(async (signal) => {
    let res: Response;
    try {
      res = await fetch(searchUrl, {
        headers: { "User-Agent": config.fetch.userAgent, Accept: "text/html" },
        redirect: "follow",
        signal,
      });
    } catch (err) {
      reportNetworkFailure();
      throw err;
    }
    reportNetworkSuccess();
    const body = await res.text();
    if (!res.ok) {
      assertNotEdgeChallenge("avature", searchUrl, body);
      throw atsHttpError("avature", res.status, body);
    }
    const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ");
    return { html: body, cookie: jar, finalUrl: res.url || searchUrl };
  });
  const page = parseAvaturePortalPage(html);
  if (!page) {
    assertNotEdgeChallenge("avature", finalUrl, html);
    throw new Error(`avature: ${finalUrl} has no JobList widget on re-fetch, so the portal list API cannot be called`);
  }
  return { page, cookie, finalUrl };
}

export async function listAvaturePortal(
  company: AdapterCompany,
  searchUrl: string,
  opts: { interPageDelayMs?: number } = {},
): Promise<NormalizedPosting[]> {
  const { page, cookie, finalUrl } = await portalSession(searchUrl);
  const origin = new URL(finalUrl).origin;
  const seen = new Set<string>();
  return paginate<NormalizedPosting>({
    provider: "avature",
    company: company.slug,
    pageSize: "infer",
    maxPages: DEFAULT_MAX_PAGES,
    dedupeBy: (p) => p.externalId,
    ...(opts.interPageDelayMs !== undefined ? { interPageDelayMs: opts.interPageDelayMs } : {}),
    fetchPage: async (offset) => {
      const raw = await atsFetchJson(avaturePortalListUrl(origin, page, offset, PAGE_SIZE), {
        provider: "avature",
        headers: { Cookie: cookie, Referer: finalUrl },
      });
      const { postings, total, rawCount } = parseAvaturePortalList(raw, company, finalUrl);
      const fresh = postings.filter((p) => !seen.has(p.externalId));
      // past the last offset the engine wraps back to page one, so a page of only known ids is the end
      if (postings.length > 0 && fresh.length === 0) return { items: [], total };
      for (const p of fresh) seen.add(p.externalId);
      return { items: postings, total, rawCount };
    },
  });
}
