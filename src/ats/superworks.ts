// src/ats/superworks.ts — Superworks Recruit white-label career sites, one
// tenant per subdomain: <slug>.superworks.com/job/listing.
//
// NOTE — this is NOT a plain server-rendered HTML board (unlike Trakstar):
// the site is a Next.js App Router app. The job data is never present as
// cheerio-selectable DOM (no <div class="job-card">-style markup) — it's
// embedded inline in the raw HTTP response as an escaped React Server
// Components ("Flight") payload, inside one or more
//   <script>self.__next_f.push([1, "<escaped-chunk>"])</script>
// tags. Concatenating and JSON-unescaping every chunk recovers a single
// "Flight text" blob containing plain (if occasionally $-ref-laden) JSON:
//
//   list:   GET <origin>/job/listing -> Flight text contains one
//           `"initialData":{ "companyInfo": { "companyName" }, "jobList": [
//           { "_id", "name", "locationInfo": [{"name"}] }, ... ] }`
//           object with EVERY posting (no pagination — a `?page=2` query
//           param is silently ignored, verified live on refrens: same 17
//           rows either way). The externalId is Mongo `_id`; job URLs are
//           `<origin>/job/details/<_id>`. A subdomain Superworks does not host
//           serves the same shell with NO initialData at all — see
//           assertSuperworksTenantExists.
//
//   jd:     GET <origin>/job/details/<_id> -> Flight text contains
//           `"jobDescription":{"description": ... }`. For any JD long
//           enough, Flight streams the HTML body out-of-line as a "Text"
//           record referenced by a `"$<id>"` placeholder; the record itself
//           looks like `<id>:T<hex-byte-length>,<raw HTML bytes>` elsewhere
//           in the same blob. Short strings may appear inline instead of a
//           ref — both are handled.
//
// Because everything needed is in the plain (non-JS-executed) HTTP body, no
// browser/XHR capture is required — a plain GET is sufficient for both list
// and JD, same operational shape as Trakstar (one unpaginated page).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin, collapseWs, extractBalanced } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

/** The one (unpaginated — `?page=` is ignored server-side) listing page. */
export function superworksListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/job/listing`;
}

/**
 * Unescape a JSON string body (the content between the outer quotes) back to
 * its literal text, via the standard `JSON.parse('"' + body + '"')` trick.
 * Zod-validated instead of cast, per the no-cast house rule. Returns null on
 * malformed input rather than throwing.
 */
function unescapeJsonStringBody(body: string): string | null {
  const parsed = tryParseJson(`"${body}"`);
  if (parsed === null) return null;
  const result = z.string().safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Concatenate + JSON-unescape every `self.__next_f.push([1, "<chunk>"])`
 * payload in a superworks HTML response into one "Flight text" blob. Chunks
 * that fail to unescape (shouldn't happen on well-formed pages) are skipped
 * rather than aborting the whole parse.
 */
function extractFlightText(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const group = m[1];
    if (group === undefined) continue;
    const unescaped = unescapeJsonStringBody(group);
    if (unescaped !== null) parts.push(unescaped);
  }
  return parts.join("");
}

const JobListItemSchema = z.object({
  _id: z.string(),
  name: z.string(),
  locationInfo: z.array(z.object({ name: z.string() })).optional(),
});

const InitialDataSchema = z.object({
  jobList: z.array(JobListItemSchema),
});

// The tenant-identity block Superworks resolves from the SUBDOMAIN, and the
// first key inside initialData on every page a real tenant serves — including
// job-detail pages, which carry no jobList at all. Its presence therefore says
// "this subdomain is a Superworks tenant" independently of how many jobs are open.
const TenantIdentitySchema = z.object({
  companyInfo: z.object({ companyName: z.string() }),
});

/** The embedded `initialData` object as raw JSON, or null when the page has none. */
function extractInitialData(html: string): JsonValue | null {
  const raw = extractBalanced(extractFlightText(html), '"initialData":', "{");
  if (!raw) return null;
  return tryParseJson(raw);
}

/**
 * The tenant name the board resolved from its own subdomain, or null when the
 * response carries no tenant-identity block at all.
 */
export function superworksTenantName(html: string): string | null {
  const initialData = extractInitialData(html);
  if (initialData === null) return null;
  const result = TenantIdentitySchema.safeParse(initialData);
  if (!result.success) return null;
  return result.data.companyInfo.companyName.trim() || null;
}

/**
 * Throw when the listing page carries no tenant identity — i.e. the subdomain is
 * not a Superworks board.
 *
 * A subdomain Superworks does not host does NOT 404, and does not leave the host
 * either: <slug>.superworks.com answers HTTP 200 with the same Next.js shell a
 * real tenant serves, titled "Jobs & Careers | Recruit Superworks" (the vendor's
 * generic default rather than the tenant's name), and its Flight payload resolves
 * the page record to an RSC error instead of page data. There is no "initialData"
 * anywhere in it, so extractBalanced found nothing, parseSuperworksList returned
 * [] and listPostings resolved with zero postings — indistinguishable from a board
 * with nothing open today. Nothing failed, so consecutive_failures never moved.
 *
 * What separates the two is the tenant-identity block, not the job list:
 * initialData.companyInfo.companyName is resolved from the subdomain and is
 * present on every page a real tenant serves. Probed 2026-08-03: present on both
 * live rows (refrens, insidefpv), and — the case that matters — present on a
 * refrens job-detail page fetched with a nonexistent job id, whose initialData
 * carries companyInfo with no jobList whatsoever. So a tenant that closes every
 * job still identifies itself and still returns [], while a subdomain the vendor
 * does not host identifies nobody. Neither live board could be made to serve an
 * empty jobList directly: the listing page ignores every filter/paging query
 * param tried (search, searchText, location, department, jobType, page).
 *
 * Runs only after the parse comes up empty, so a page that yielded postings can
 * never be failed by this.
 *
 * A bot-blocker's challenge page carries no initialData either, so it is checked
 * for first and thrown infrastructure-shaped instead: an edge refusing us is
 * retried and deferred, never charged to the row.
 */
export function assertSuperworksTenantExists(html: string, slug: string, listUrl: string): void {
  if (superworksTenantName(html) !== null) return;
  assertNotEdgeChallenge("superworks", listUrl, html);

  throw new Error(
    `superworks: tenant does not exist — the board for ${slug} carries no ` +
      `initialData.companyInfo.companyName, so the subdomain served the vendor's generic shell ` +
      `rather than a tenant board, and it is dead rather than empty.`,
  );
}

/** Parse the listing page's embedded `initialData.jobList` into postings. */
export function parseSuperworksList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const parsed = extractInitialData(html);
  if (parsed === null) return [];

  const result = InitialDataSchema.safeParse(parsed);
  if (!result.success) return [];

  const base = tenantOrigin(company);
  const postings: NormalizedPosting[] = [];

  for (const job of result.data.jobList) {
    const title = collapseWs(job.name);
    if (!job._id || !title) continue;

    const location = job.locationInfo?.map((l) => collapseWs(l.name)).filter(Boolean).join(", ") || null;
    const isRemote = location ? REMOTE_RE.test(location) : false;

    postings.push({
      provider: "superworks",
      externalId: job._id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: new URL(`/job/details/${job._id}`, base).toString(),
      location,
      isRemote,
      jdText: "",
      postedAt: null,
    });
  }

  return postings;
}

/**
 * Resolve a Flight "Text" record: `<id>:T<hex-byte-length>,<raw bytes>`
 * elsewhere in the same blob. Byte-length (not char-length) matters because
 * the hex count is UTF-8 bytes and JD HTML can contain multi-byte chars.
 */
function resolveTextRecord(flightText: string, refId: string): string | null {
  const escapedId = refId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)${escapedId}:T([0-9a-f]+),`);
  const m = re.exec(flightText);
  if (!m) return null;
  const hexLen = m[1];
  if (!hexLen) return null;
  const byteLen = parseInt(hexLen, 16);
  const payloadStart = m.index + m[0].length;

  const prefix = flightText.slice(0, payloadStart);
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const fullBuf = Buffer.from(flightText, "utf8");
  return fullBuf.subarray(prefixBytes, prefixBytes + byteLen).toString("utf8");
}

/** Extract the JD body (`jobDescription.description`) from a job detail page. */
export function parseSuperworksJd(html: string): string {
  const flightText = extractFlightText(html);
  const m = /"jobDescription":\{"description":"((?:\\.|[^"\\])*)"/.exec(flightText);
  if (!m) return "";
  const raw = m[1];
  if (raw === undefined) return "";

  const refMatch = /^\$([0-9a-zA-Z]+)$/.exec(raw);
  const bodyHtml: string | null = refMatch?.[1]
    ? resolveTextRecord(flightText, refMatch[1])
    : unescapeJsonStringBody(raw);

  return bodyHtml ? htmlToText(bodyHtml) : "";
}

export const superworksAdapter: AtsAdapter = {
  provider: "superworks",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(superworksListUrl(company), { provider: "superworks" });
    const postings = parseSuperworksList(html, company);
    // Only on a zero-row parse: a page that yielded postings is a live tenant
    // whatever else its payload happens to carry.
    if (postings.length === 0) {
      assertSuperworksTenantExists(html, company.slug, superworksListUrl(company));
    }
    return postings;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "superworks" });
    return parseSuperworksJd(html);
  },
};
