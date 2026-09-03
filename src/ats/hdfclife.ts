// list: POST get-open-requisition -> results.results[] JOB_ROLE buckets, each with REQUISITION.results[] (whole board in one call, no pagination)
// jd: POST get-job-descriptions -> results.JOBDESCRIPTION (HTML)
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

// Key is the first 32 chars of REQUEST_TOKEN as UTF-8 bytes; if HDFC rotates it, grep a fresh script.js for the `new Encrypter("<token>", "<iv>")` literals feeding the request call.
export const REQUEST_TOKEN =
  "ob1VbQlyRRaKms81nzKB91hjb4QvmP-5f7jSdTgmOIzNvWh5-eLFykYnBx7_1flXG7MGYXSwcVKplNypX26VC19wHmYI4RZFD9uiUfjj3pyUOG-YX7-TkGzIUTpMEE2Bm9YDYBpNRzI6FGns0csd0t1XU7hoVuwazD_NEMJiv2f68HaM7zf_YKHIJHamig2p7jWtBnaUSvm5UZi3wJSw_B7A6qiIFKFYstdxQJCTv7G1jyTmBIWWi23rQ8";
// 11-byte IV (not the usual 12); node's createCipheriv accepts it, SubtleCrypto would reject it.
export const REQUEST_IV = "vS7YzoFtgUU1Ovf";

const AUTH_TAG_LEN = 16;

/** AES-256-GCM encrypt as the site's Encrypter does: key token[:32] as UTF-8, iv base64-decoded, output base64(cipher||tag). */
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

// JD endpoint's `results` is FLAT (unlike list's `results.results` array); JOB_DESC is the real HTML string, JOBDESCRIPTION is a nested object on this tenant, so only a non-empty string field is used (JOB_DESC first).
const DetailEnvelopeSchema = z.object({
  results: z.object({
    JOB_DESC: JsonValueSchema.optional(),
    JOBDESCRIPTION: JsonValueSchema.optional(),
  }),
});

/** Flatten the two-level list envelope (JOB_ROLE buckets -> REQUISITION.results). Throws on an unexpected envelope. */
export function flattenHdfcRequisitions(raw: JsonValue): HdfcRequisition[] {
  const parsed = ListEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`hdfclife: list response failed schema (${parsed.error.issues[0]?.message ?? "?"})`);
  return parsed.data.results.results.flatMap((b) => b.REQUISITION?.results ?? []);
}

/** Full JD from a get-job-descriptions envelope, as plain text; "" when the shape is unexpected (degrade, don't fail the posting). */
export function hdfcJdFromDetail(raw: JsonValue): string {
  const parsed = DetailEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return "";
  const r = parsed.data.results;
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
    // No per-job public URL exists (apply happens inside the SPA), so anchor into the careers page by reqId.
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

/** POST an encrypted request; response arrives under a FRESH rotating token/iv (returned in cleartext), decrypted under those rather than the static request ones. */
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
