// src/ats/icicibank.ts — ICICI Bank careers SPA (careers.icici.bank.in), single-tenant hardcoded adapter
// (not tenant_url/apiMeta driven). AES-128-CBC/PKCS7, traced from the SPA bundle: 16-byte UTF-8 key,
// random 16-char IV generated per request and appended in PLAIN TEXT after the base64 ciphertext (same
// scheme both directions). list: POST Career/Search/1 (0-based PageNo+limit; exhausted page =
// ResponseCode 103, no Data, unencrypted). jd: GET Career/getMobileJd/<id>, plain UNENCRYPTED JSON (the
// list's hc_JD is always empty). Both endpoints WAF-block the bot UA — use BROWSER_UA.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrNull } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

// Single-tenant: this is ICICI Bank's own site, not a SaaS ATS host pattern.
const API_BASE = "https://careers.icici.bank.in/CareerApplicantApi";
const SPA_ORIGIN = "https://careers.icici.bank.in/CareerApplicant";
const SEARCH_URL = `${API_BASE}/Career/Search/1`;
const jdUrl = (jobId: string): string => `${API_BASE}/Career/getMobileJd/${encodeURIComponent(jobId)}`;

const PAGE_SIZE = 12; // matches the real client's /Career/job-listing/ page.

// If ICICI rotates keys: grep a fresh bundle for the enc.Utf8.parse("...") literal feeding the AES call
// that slices a 16-char IV suffix off its input/output.
const ENCRYPT_KEY = "$k@m0u$0172@0r!k";
const IV_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomIv(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += IV_ALPHABET[Math.floor(Math.random() * IV_ALPHABET.length)];
  return out;
}

/** Encrypt a request payload as the SPA does: AES-128-CBC/PKCS7 under `ENCRYPT_KEY` with a fresh random IV, appended in plain text after the base64 ciphertext. */
export function encryptPayload<T>(value: T): string {
  const iv = randomIv();
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), Buffer.from(iv, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ciphertext.toString("base64") + iv;
}

/** Decrypt a response (or echoed request) blob: last 16 chars are the IV, the rest is base64 ciphertext. Throws if too short or the key/IV don't unpad cleanly. */
export function decryptPayload(blob: string): JsonValue {
  if (blob.length <= 16) throw new Error(`icicibank: ciphertext too short to hold a 16-char IV suffix (${blob.length})`);
  const iv = blob.slice(blob.length - 16);
  const ciphertext = blob.slice(0, blob.length - 16);
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), Buffer.from(iv, "utf8"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return JsonValueSchema.parse(JSON.parse(plaintext.toString("utf8")));
}

/** Request body shape for Career/Search/1 (pre-encryption), mirrors the real client's fields exactly. */
export interface IciciSearchRequest {
  userId: number;
  ApplicantId: string;
  keyword: string;
  maingroup: string;
  experience: string;
  PageNo: number;
  limit: number;
  isAllIndia: number;
}

function searchRequest(pageNo: number): IciciSearchRequest {
  return {
    userId: 1, ApplicantId: "", keyword: "", maingroup: "", experience: "",
    PageNo: pageNo, limit: PAGE_SIZE, isAllIndia: 3, // isAllIndia:3 == the site's "All Jobs" tab.
  };
}

// Encrypted-envelope response: {"Data": "<ciphertext>"} on a page with results; exhausted pagination drops `Data` and reports ResponseCode 103.
const SearchEnvelopeSchema = z.object({
  Data: z.string().optional(),
  ResponseCode: z.number().optional(),
  ResponseMessage: z.string().optional(),
});

export const IciciJobSchema = z.object({
  hc_JobID: z.union([z.string(), z.number()]),
  hc_JobTitle: z.string(),
  hc_Location: z.string().nullable().optional(),
  hc_JobType: z.string().nullable().optional(),
  hc_Experience: z.string().nullable().optional(),
  hc_MainGroup: z.string().nullable().optional(),
  Total_Rows: z.number().nullable().optional(),
});
export type IciciJob = z.infer<typeof IciciJobSchema>;

const JdEnvelopeSchema = z.object({
  Data: z.array(z.object({ JD: z.string().nullable().optional() })).optional(),
});

/** Unwrap+decrypt one Career/Search/1 response. `null` means "no more pages" (ResponseCode 103). */
export function parseSearchEnvelope(json: JsonValue): IciciJob[] | null {
  const parsed = SearchEnvelopeSchema.parse(json);
  if (!parsed.Data) return null;
  const decrypted = decryptPayload(parsed.Data);
  return z.array(IciciJobSchema).parse(decrypted);
}

export function normalizeIcici(company: AdapterCompany, j: IciciJob): NormalizedPosting {
  const id = String(j.hc_JobID);
  const rawLocation = j.hc_Location;
  const location = rawLocation && rawLocation.toLowerCase() !== "null" ? rawLocation : null;
  return {
    provider: "icicibank",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.hc_JobTitle,
    jobUrl: `${SPA_ORIGIN}/Career/job-details/${id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // hc_JD is always empty on the list endpoint; fetchJd hits getMobileJd.
    postedAt: null, // f_createdDate/hc_EndDate are template/deadline dates, not real posting dates.
  };
}

export const icicibankAdapter: AtsAdapter = {
  provider: "icicibank",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "icicibank",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(SEARCH_URL, {
          method: "POST",
          body: { data: encryptPayload(searchRequest(page)) },
          provider: "icicibank",
          userAgent: BROWSER_UA,
        });
        const jobs = parseSearchEnvelope(json);
        if (!jobs) return { items: [], total: null, rawCount: 0 };
        return {
          items: jobs.map((j) => normalizeIcici(company, j)),
          total: jobs[0]?.Total_Rows ?? null,
          rawCount: jobs.length,
        };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const json = await atsFetchJson(jdUrl(posting.externalId), {
      provider: "icicibank",
      userAgent: BROWSER_UA,
    });
    const parsed = parseOrNull(JdEnvelopeSchema, json, {
      provider: "icicibank",
      slug: posting.companySlug,
      what: `getMobileJd ${posting.externalId}`,
    });
    if (!parsed) return "";
    const jd = parsed.Data?.[0]?.JD ?? "";
    return htmlToText(jd);
  },
};
