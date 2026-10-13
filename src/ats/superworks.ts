// Job data is in the RSC "Flight" payload (self.__next_f.push chunks): initialData.jobList (unpaginated) and per-detail jobDescription.description (sometimes an out-of-line "$id:T<hexlen>,<bytes>" record).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin, collapseWs, extractBalanced } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

/** Unpaginated: `?page=` is ignored server-side. */
export function superworksListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/job/listing`;
}

function unescapeJsonStringBody(body: string): string | null {
  const parsed = tryParseJson(`"${body}"`);
  if (parsed === null) return null;
  const result = z.string().safeParse(parsed);
  return result.success ? result.data : null;
}

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

const TenantIdentitySchema = z.object({
  companyInfo: z.object({ companyName: z.string() }),
});

function extractInitialData(html: string): JsonValue | null {
  const raw = extractBalanced(extractFlightText(html), '"initialData":', "{");
  if (!raw) return null;
  return tryParseJson(raw);
}

export function superworksTenantName(html: string): string | null {
  const initialData = extractInitialData(html);
  if (initialData === null) return null;
  const result = TenantIdentitySchema.safeParse(initialData);
  if (!result.success) return null;
  return result.data.companyInfo.companyName.trim() || null;
}

/** An unhosted subdomain answers 200 with the generic shell and no initialData, like a real tenant with zero jobs; only a real tenant resolves initialData.companyInfo.companyName. */
export function assertSuperworksTenantExists(html: string, slug: string, listUrl: string): void {
  if (superworksTenantName(html) !== null) return;
  assertNotEdgeChallenge("superworks", listUrl, html);

  throw new Error(
    `superworks: tenant does not exist — the board for ${slug} carries no ` +
      `initialData.companyInfo.companyName, so the subdomain served the vendor's generic shell ` +
      `rather than a tenant board, and it is dead rather than empty.`,
  );
}

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

/** Length is the hex UTF-8 byte count, not chars: JD HTML can hold multi-byte chars. */
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
