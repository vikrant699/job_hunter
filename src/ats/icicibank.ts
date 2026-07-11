// src/ats/icicibank.ts — ICICI Bank's careers SPA (careers.icici.bank.in).
//
// Single-tenant, not a multi-company ATS platform: everything below is
// hardcoded to this one bank's own hand-rolled API, not derived from
// `company.tenantUrl`/`company.apiMeta` the way multi-tenant adapters are.
//
// Client-side-encrypted API. Traced from the SPA bundle (main.*.chunk.js,
// webpack module "0" of chunk id 20, "webpackJsonpcareer-document") and
// confirmed live against captured network traffic (2026-07):
//
//   - AES-128-CBC, PKCS7 padding. The bundle builds keys/IVs via CryptoJS's
//     `enc.Utf8.parse(str)`, i.e. the literal strings below are used as their
//     raw UTF-8 bytes (16 bytes = AES-128), not base64/hex.
//   - The IV is NOT fixed. The encryptor generates a random 16-character
//     alphanumeric string, uses it as the IV, AES-encrypts, then appends the
//     IV string IN PLAIN TEXT after the base64 ciphertext. The decryptor does
//     the reverse: slice the last 16 characters off as the IV, base64-decode
//     the remainder as ciphertext. Same scheme both directions (request
//     bodies and response bodies), under the SAME key.
//   - The bundle actually defines TWO keys for this "payload-derived IV"
//     scheme ("$P@mOu$0172@0r!P" and "$k@m0u$0172@0r!k"). Live traffic for
//     every CareerApplicantApi endpoint we could reach with a browser UA —
//     getToken, Career/Banner, Career/portfolioListing, Career/GetMoreJobs,
//     and the job-search endpoint used here — decrypted only under the
//     SECOND key. If ICICI ever rotates keys, grep a fresh bundle for
//     `enc.Utf8.parse("` literals feeding `AES.encrypt`/`AES.decrypt` calls
//     that also slice a 16-char suffix off their input — that is this scheme.
//
// Endpoint (confirmed live, 2026-07-10): the FULL public job list is
//   POST https://careers.icici.bank.in/CareerApplicantApi/Career/Search/1
//   body {"data": <encrypted `IciciSearchRequest`>}
//   -> {"Data": <encrypted JSON array of job rows>, "ResponseCode": 100}
// Paginated via 0-based `PageNo` + `limit`; each job row carries `Total_Rows`
// (total count for the query). Exhausted pages come back as
// {"ResponseMessage":"No Record Found","ResponseCode":103} (no `Data` field)
// — a clean, unencrypted termination signal.
//
// The JD is NOT included in the search response (`hc_JD` is always ""). The
// per-job description lives at:
//   GET https://careers.icici.bank.in/CareerApplicantApi/Career/getMobileJd/<jobId>
// which — unlike every other endpoint here — is plain, UNENCRYPTED JSON:
// {"Data":[{..., "JD": "<html>"}]}. JD MANDATORY per adapter contract, so
// `fetchJd` hits this endpoint per posting.
//
// Both endpoints 403/WAF-block the default bot UA (confirmed live: returns an
// HTML error page, not JSON) — same story as Jibe — so both requests go out
// with a browser UA.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

// Single-tenant: this is ICICI Bank's own site, not a SaaS ATS host pattern.
const API_BASE = "https://careers.icici.bank.in/CareerApplicantApi";
const SPA_ORIGIN = "https://careers.icici.bank.in/CareerApplicant";
const SEARCH_URL = `${API_BASE}/Career/Search/1`;
const jdUrl = (jobId: string): string => `${API_BASE}/Career/getMobileJd/${encodeURIComponent(jobId)}`;

const PAGE_SIZE = 12; // matches the real client's /Career/job-listing/ page.

// See the module header for provenance. Read from a constant so a future key
// rotation is a one-line patch: re-derive by grepping a fresh bundle for the
// `enc.Utf8.parse("...")` literal feeding the AES call that slices a 16-char
// IV suffix off its input/output.
const ENCRYPT_KEY = "$k@m0u$0172@0r!k";
const IV_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomIv(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += IV_ALPHABET[Math.floor(Math.random() * IV_ALPHABET.length)];
  return out;
}

/**
 * Encrypt a request payload the way the SPA does: AES-128-CBC/PKCS7 under
 * `ENCRYPT_KEY` with a fresh random IV, IV appended in plain text after the
 * base64 ciphertext. Exported for the round-trip test.
 */
export function encryptPayload(value: unknown): string {
  const iv = randomIv();
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), Buffer.from(iv, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ciphertext.toString("base64") + iv;
}

/**
 * Decrypt a response (or echoed request) blob: the last 16 characters are
 * the IV, the rest is base64 ciphertext. Throws if the blob is shorter than
 * an IV (malformed) or the key/IV don't unpad cleanly (wrong key — see the
 * module header on key rotation).
 */
export function decryptPayload(blob: string): unknown {
  if (blob.length <= 16) throw new Error(`icicibank: ciphertext too short to hold a 16-char IV suffix (${blob.length})`);
  const iv = blob.slice(blob.length - 16);
  const ciphertext = blob.slice(0, blob.length - 16);
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(ENCRYPT_KEY, "utf8"), Buffer.from(iv, "utf8"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
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

// Encrypted-envelope response: {"Data": "<ciphertext>", "ResponseCode": 100}
// on a page with results; exhausted pagination drops `Data` entirely and
// reports {"ResponseMessage":"No Record Found","ResponseCode":103}.
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
export function parseSearchEnvelope(json: unknown): IciciJob[] | null {
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
    const parsed = JdEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn(
        { slug: posting.companySlug, jobId: posting.externalId, issues: parsed.error.issues.slice(0, 2) },
        "icicibank getMobileJd schema mismatch",
      );
      return "";
    }
    const jd = parsed.data.Data?.[0]?.JD ?? "";
    return htmlToText(jd);
  },
};
