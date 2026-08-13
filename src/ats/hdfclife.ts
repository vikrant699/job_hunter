// src/ats/hdfclife.ts — HDFC Life careers ("find your fit", hdfclife.com).
//
// Single-tenant, not a multi-company ATS: everything is hardcoded to HDFC
// Life's own encrypted career-portal API (mist.api-hdfclife.com), traced from
// the site's client JS (js/script.js's Encrypter class) and confirmed live
// (2026-08-13, 1,508 postings).
//
// Client-side-encrypted API, AES-256-GCM:
//   - key = the first 32 chars of a long STATIC token string, as raw UTF-8
//     bytes; iv = base64-decode of a static string -> an 11-byte nonce (not the
//     usual 12; node:crypto accepts it, SubtleCrypto rejects it, which is why we
//     use createCipheriv/createDecipheriv here).
//   - ciphertext is base64(AES-GCM(plaintext) || 16-byte auth tag).
//   - The REQUEST is encrypted under the static token/iv below. The RESPONSE
//     comes back as { data: { token, iv, payload } } where token/iv rotate per
//     call but are returned IN CLEARTEXT, so we decrypt payload under THOSE.
//     If HDFC rotates the static request token, grep a fresh js/script.js for
//     the `new Encrypter("<token>", "<iv>")` literals feeding the request call.
//
// Endpoints (confirmed live):
//   list: POST mist.api-hdfclife.com/career-portal/get-open-requisition
//         body {token, iv, payload: enc({jobRole:"All", functionParam:[], ...})}
//         -> results.results[] buckets (one per JOB_ROLE), each with
//            REQUISITION.results[] of jobs. The whole board (1,508) comes back
//            in ONE call — no pagination.
//   jd:   POST mist.api-hdfclife.com/career-portal/get-job-descriptions
//         body {token, iv, payload: enc({reqId})} -> results.results[0].JOBDESCRIPTION (HTML)
import { createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { withAtsTimeout } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";

const API_BASE = "https://mist.api-hdfclife.com/career-portal";
const LIST_URL = `${API_BASE}/get-open-requisition`;
const JD_URL = `${API_BASE}/get-job-descriptions`;
const CAREERS_URL = "https://www.hdfclife.com/hdfc-careers/find-your-fit.html";

// Static request key material lifted from the site's client JS (see header on
// rotation). The key is the first 32 chars of REQUEST_TOKEN, as UTF-8 bytes.
export const REQUEST_TOKEN =
  "ob1VbQlyRRaKms81nzKB91hjb4QvmP-5f7jSdTgmOIzNvWh5-eLFykYnBx7_1flXG7MGYXSwcVKplNypX26VC19wHmYI4RZFD9uiUfjj3pyUOG-YX7-TkGzIUTpMEE2Bm9YDYBpNRzI6FGns0csd0t1XU7hoVuwazD_NEMJiv2f68HaM7zf_YKHIJHamig2p7jWtBnaUSvm5UZi3wJSw_B7A6qiIFKFYstdxQJCTv7G1jyTmBIWWi23rQ8";
export const REQUEST_IV = "vS7YzoFtgUU1Ovf";

const AUTH_TAG_LEN = 16;

/** AES-256-GCM encrypt a JSON value the way the site's Encrypter does: key is
 *  token[:32] as UTF-8, iv is base64-decoded, output is base64(cipher||tag). */
export function hdfcEncrypt(value: JsonValue, token: string, ivB64: string): string {
  const key = Buffer.from(token.slice(0, 32), "utf8");
  const iv = Buffer.from(ivB64, "base64");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString("base64");
}

/** Reverse of hdfcEncrypt: split the trailing 16-byte GCM tag, decrypt, JSON-parse. */
export function hdfcDecrypt(blob: string, token: string, ivB64: string): JsonValue {
  const buf = Buffer.from(blob, "base64");
  if (buf.length <= AUTH_TAG_LEN) throw new Error(`hdfclife: ciphertext too short (${buf.length} bytes)`);
  const key = Buffer.from(token.slice(0, 32), "utf8");
  const iv = Buffer.from(ivB64, "base64");
  const tag = buf.subarray(buf.length - AUTH_TAG_LEN);
  const ct = buf.subarray(0, buf.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JsonValueSchema.parse(JSON.parse(out.toString("utf8")));
}

const RequisitionSchema = z.object({
  REQID: z.union([z.string(), z.number()]).transform(String),
  DESIGNATION: z.string(),
  CITY: z.string().nullable().optional(),
  LOC_NAME: z.string().nullable().optional(),
  DEPT_NAME: z.string().nullable().optional(),
  EXPERIENCE: z.string().nullable().optional(),
  NO_OPENING: z.union([z.string(), z.number()]).nullable().optional(),
});
export type HdfcRequisition = z.infer<typeof RequisitionSchema>;

const ListEnvelopeSchema = z.object({
  results: z.object({
    results: z.array(
      z.object({
        JOB_ROLE: z.string().nullable().optional(),
        REQUISITION: z.object({ results: z.array(RequisitionSchema) }).nullable().optional(),
      }),
    ),
  }),
});

// The JD endpoint returns `results` as a FLAT object (unlike the list, whose
// `results.results` is an array). The plain-text/HTML body lives in JOB_DESC
// (a string); JOBDESCRIPTION also appears but its value is a NESTED OBJECT on
// this tenant, so both fields are read leniently as JsonValue and only a
// non-empty string is used (JOB_DESC first).
const DetailEnvelopeSchema = z.object({
  results: z.object({
    JOB_DESC: JsonValueSchema.optional(),
    JOBDESCRIPTION: JsonValueSchema.optional(),
  }),
});

/** Flatten the two-level list envelope (JOB_ROLE buckets -> REQUISITION.results)
 *  into one array of jobs. Throws on an unexpected envelope (real field drift). */
export function flattenHdfcRequisitions(raw: JsonValue): HdfcRequisition[] {
  const parsed = ListEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`hdfclife: list response failed schema (${parsed.error.issues[0]?.message ?? "?"})`);
  return parsed.data.results.results.flatMap((b) => b.REQUISITION?.results ?? []);
}

/** Full JD (JOBDESCRIPTION, HTML) from a get-job-descriptions envelope, as plain
 *  text; "" when the shape is unexpected (degrade, don't fail the posting). */
export function hdfcJdFromDetail(raw: JsonValue): string {
  const parsed = DetailEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return "";
  const r = parsed.data.results;
  // JOB_DESC is the reliable HTML string; JOBDESCRIPTION is a nested object on
  // this tenant, so take whichever field is actually a non-empty string.
  const body = [r.JOB_DESC, r.JOBDESCRIPTION].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return body ? htmlToText(body) : "";
}

export function normalizeHdfc(company: AdapterCompany, r: HdfcRequisition): NormalizedPosting {
  const city = r.CITY && r.CITY.trim() ? r.CITY.trim() : null;
  const location = city ?? (r.LOC_NAME && r.LOC_NAME.trim() ? r.LOC_NAME.trim() : null);
  return {
    provider: "hdfclife",
    externalId: r.REQID,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.DESIGNATION.trim(),
    // No per-job public URL exists (apply happens inside the SPA), so anchor
    // into the careers page by reqId rather than invent one.
    jobUrl: `${CAREERS_URL}#job-${r.REQID}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // fetched separately via get-job-descriptions
    postedAt: null, // the API exposes no posting date
  };
}

const LIST_PAYLOAD: JsonValue = {
  jobRole: "All", functionParam: [], locationParam: [], dob: "",
  totalWorkExpParam: "", totalSalesExpParam: "", totalBFSIExp: "", qualification: "", living: "",
};

const EnvelopeSchema = z.object({ data: z.object({ token: z.string(), iv: z.string(), payload: z.string() }) });

/** POST an encrypted request, decrypt the rotating-key response envelope. */
async function hdfcPost(url: string, payload: JsonValue): Promise<JsonValue> {
  await awaitNetwork();
  const body = JSON.stringify({
    token: REQUEST_TOKEN,
    iv: REQUEST_IV,
    payload: hdfcEncrypt(payload, REQUEST_TOKEN, REQUEST_IV),
  });
  let res: Response;
  try {
    res = await withAtsTimeout((signal) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": BROWSER_UA,
          Origin: "https://www.hdfclife.com",
          Referer: CAREERS_URL,
        },
        body,
        signal,
      }),
    );
  } catch (err) {
    reportNetworkFailure();
    throw err;
  }
  reportNetworkSuccess();
  if (!res.ok) throw new Error(`hdfclife HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const env = EnvelopeSchema.parse(JsonValueSchema.parse(await res.json()));
  return hdfcDecrypt(env.data.payload, env.data.token, env.data.iv);
}

export const hdfclifeAdapter: AtsAdapter = {
  provider: "hdfclife",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await hdfcPost(LIST_URL, LIST_PAYLOAD);
    return flattenHdfcRequisitions(raw).map((r) => normalizeHdfc(company, r));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await hdfcPost(JD_URL, { reqId: posting.externalId });
    return hdfcJdFromDetail(raw);
  },
};
