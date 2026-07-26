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
//           `"initialData":{ "jobList": [ { "_id", "name", "locationInfo": [{"name"}] }, ... ] }`
//           object with EVERY posting (no pagination — a `?page=2` query
//           param is silently ignored, verified live on refrens: same 17
//           rows either way). The externalId is Mongo `_id`; job URLs are
//           `<origin>/job/details/<_id>`.
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
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin } from "./shared.js";
import { tryParseJson } from "../util/json.js";

/** The one (unpaginated — `?page=` is ignored server-side) listing page. */
export function superworksListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/job/listing`;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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

/**
 * Extract the balanced JSON object following the first `"initialData":`
 * key in a Flight text blob. Returns null if the key is absent or the
 * object is unbalanced (defensive against a vendor markup change).
 */
function extractInitialDataJson(flightText: string): string | null {
  const key = '"initialData":';
  const keyIdx = flightText.indexOf(key);
  if (keyIdx === -1) return null;
  const start = flightText.indexOf("{", keyIdx + key.length);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < flightText.length; i++) {
    const c = flightText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return flightText.slice(start, i + 1);
    }
  }
  return null;
}

const JobListItemSchema = z.object({
  _id: z.string(),
  name: z.string(),
  locationInfo: z.array(z.object({ name: z.string() })).optional(),
});

const InitialDataSchema = z.object({
  jobList: z.array(JobListItemSchema),
});

/** Parse the listing page's embedded `initialData.jobList` into postings. */
export function parseSuperworksList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const flightText = extractFlightText(html);
  const raw = extractInitialDataJson(flightText);
  if (!raw) return [];

  const parsed = tryParseJson(raw);
  if (parsed === null) return [];

  const result = InitialDataSchema.safeParse(parsed);
  if (!result.success) return [];

  const base = tenantOrigin(company);
  const postings: NormalizedPosting[] = [];

  for (const job of result.data.jobList) {
    const title = cleanText(job.name);
    if (!job._id || !title) continue;

    const location = job.locationInfo?.map((l) => cleanText(l.name)).filter(Boolean).join(", ") || null;
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
    return parseSuperworksList(html, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "superworks" });
    return parseSuperworksJd(html);
  },
};
