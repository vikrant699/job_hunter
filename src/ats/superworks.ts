// src/ats/superworks.ts — Superworks Recruit white-label career sites (<slug>.superworks.com/job/listing), a Next.js App Router app whose job data isn't in the DOM at all - it's an escaped React Server Components "Flight" payload inside <script>self.__next_f.push([1,"..."])</script> tags.
// Concatenating + JSON-unescaping every chunk recovers one "Flight text" blob holding initialData.jobList (list, unpaginated - ?page= is ignored) and, per detail page, jobDescription.description (sometimes an out-of-line "$id:T<hexlen>,<bytes>" Text record). A subdomain Superworks doesn't host serves the same shell with no initialData - see assertSuperworksTenantExists. Everything needed is in the plain HTTP body, so no browser/XHR capture is required.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin, collapseWs, extractBalanced } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

/** The one (unpaginated - `?page=` is ignored server-side) listing page. */
export function superworksListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/job/listing`;
}

/** Unescape a JSON string body back to literal text via `JSON.parse('"'+body+'"')`, zod-validated instead of cast. Null on malformed input. */
function unescapeJsonStringBody(body: string): string | null {
  const parsed = tryParseJson(`"${body}"`);
  if (parsed === null) return null;
  const result = z.string().safeParse(parsed);
  return result.success ? result.data : null;
}

/** Concatenate + unescape every `self.__next_f.push([1,"<chunk>"])` payload into one "Flight text" blob; chunks that fail to unescape are skipped rather than aborting the whole parse. */
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

// Resolved from the subdomain and present on every page a real tenant serves, including job-detail pages with no jobList - its presence says "this is a Superworks tenant" independently of how many jobs are open.
const TenantIdentitySchema = z.object({
  companyInfo: z.object({ companyName: z.string() }),
});

/** The embedded `initialData` object as raw JSON, or null when the page has none. */
function extractInitialData(html: string): JsonValue | null {
  const raw = extractBalanced(extractFlightText(html), '"initialData":', "{");
  if (!raw) return null;
  return tryParseJson(raw);
}

/** The tenant name the board resolved from its own subdomain, or null when the response carries no tenant-identity block at all. */
export function superworksTenantName(html: string): string | null {
  const initialData = extractInitialData(html);
  if (initialData === null) return null;
  const result = TenantIdentitySchema.safeParse(initialData);
  if (!result.success) return null;
  return result.data.companyInfo.companyName.trim() || null;
}

/** A subdomain Superworks doesn't host still answers 200 with the generic Next.js shell and no initialData at all - indistinguishable from a real tenant with zero open jobs, except a real tenant (even with nothing open) still resolves initialData.companyInfo.companyName from the subdomain; a bot-blocker's challenge page also carries no initialData, so it's checked for first and thrown infrastructure-shaped. */
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

/** Resolve a Flight "Text" record (`<id>:T<hex-byte-length>,<raw bytes>`); byte-length not char-length, since the hex count is UTF-8 bytes and JD HTML can contain multi-byte chars. */
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
    // Only on a zero-row parse - a page that yielded postings is a live tenant regardless.
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
