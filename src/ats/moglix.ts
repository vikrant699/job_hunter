// src/ats/moglix.ts — Moglix's careers board (moglix.flexiele.com), a
// "FlexiEle" (FE ERP) tenant. Single-tenant, hand-traced hardcoded API — not a
// multi-company ATS platform.
//
// The board is a Vite-built React SPA (index-DfTT2Ztx.js + lazy route chunks).
// Its `careers` route (careers-DpFlX4v4.js) renders a generic "grid" component
// (GRD0000837-CIWG9arB.js) whose data source is server-configured metadata, so
// the endpoint URL never appears as a literal string in the client bundle —
// only network capture (Playwright, 2026-07) revealed it:
//
//   POST https://moglix-api.flexiele.com/api-pub/rec/careers/list
//   body (before encryption): {"formCode":"FRM0001379","gridCode":"GRD0000837",
//                              "sorted":[],"requiresCounts":true,"skip":N,"take":M}
//   -> {"<8-hex-char-random-key>":"<ciphertext>"}
//
// Encryption (traced in index-DfTT2Ztx.js's axios interceptors, confirmed live
// against captured traffic):
//   - CryptoJS.AES.encrypt(JSON.stringify(body), passphrase).toString() — the
//     passphrase form (not a WordArray key) triggers CryptoJS's OpenSSL-
//     compatible "Salted__" KDF: MD5-based EVP_BytesToKey derives a 256-bit
//     key + 128-bit IV from (passphrase, an 8-byte random salt); AES-256-CBC,
//     PKCS7 padding; wire format is base64("Salted__" + salt + ciphertext).
//     node:crypto has no built-in EVP_BytesToKey, so `moglixEncrypt`/
//     `moglixDecrypt` below replicate it directly (MD5(prev + passphrase +
//     salt), repeated until enough key+IV bytes are produced).
//   - The passphrase is `environment.reqEncKey`, a literal in the bundle
//     (`environment$1.reqEncKey`, spread into the prod `environment` object
//     unchanged): "2e35f242a46d67eeb74aabc37d5e5d05". If FlexiEle ever rotates
//     it, grep a fresh index-*.js bundle for `reqEncKey:"` — same interceptor
//     shape (`Crypto.AES.encrypt(d,o)` / `Crypto.AES.decrypt(i,o)` with
//     `o=FE.reqEncKey`).
//   - Every request AND response body is wrapped in a single-key envelope
//     `{[randomHexKey]: ciphertext}` where `randomHexKey` is 4 random bytes
//     hex-encoded (CryptoJS's `WordArray.random(4).toString()`), also echoed
//     as the `fe-req-encrypted` request header. The response's envelope key
//     is server-generated and unrelated to the request's; `unwrapEnvelope`
//     just takes "the sole value" rather than matching key names.
//   - No cookies/session/CSRF token needed — confirmed with a bare
//     `fetch`+bot UA (job-hunter-bot/0.1), no browser required.
//
// Pagination: the real client's own request already asks for
// `take:50000` in one shot (moglix has ~150 openings total, confirmed live
// 2026-07), so `listPostings` mirrors that — a single POST, no loop. The `jd`
// field is inline on every list row (confirmed non-empty on 144/145 rows
// live), so `fetchJd` is not needed.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsHttpError } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const API_URL = "https://moglix-api.flexiele.com/api-pub/rec/careers/list";
const CAREERS_URL = "https://moglix.flexiele.com/careers/moglix/jobs";
const REQ_ENC_HEADER = "fe-req-encrypted";

// See module header for provenance; re-derive by grepping a fresh bundle for
// `reqEncKey:"` if this ever 403s/decrypt-fails.
const ENC_PASSPHRASE = "2e35f242a46d67eeb74aabc37d5e5d05";

const EMPTY_SORT: readonly string[] = [];
const GRID_REQUEST = { formCode: "FRM0001379", gridCode: "GRD0000837", sorted: EMPTY_SORT };
const TAKE = 50000; // generous ceiling; the real client requests the same in one shot.

// ---- CryptoJS-compatible OpenSSL "Salted__" AES-256-CBC passphrase codec ----

/**
 * CryptoJS's EvpKDF (MD5-based, matches OpenSSL's EVP_BytesToKey): derive
 * `keyLen + ivLen` bytes from (passphrase, salt) via repeated
 * MD5(prevBlock + passphrase + salt). Exported nowhere — only `moglixEncrypt`/
 * `moglixDecrypt` need it.
 */
function evpBytesToKey(passphrase: string, salt: Buffer, keyLen: number, ivLen: number): { key: Buffer; iv: Buffer } {
  let data = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  const passBuf = Buffer.from(passphrase, "utf8");
  while (data.length < keyLen + ivLen) {
    const hash = createHash("md5");
    hash.update(Buffer.concat([prev, passBuf, salt]));
    prev = hash.digest();
    data = Buffer.concat([data, prev]);
  }
  return { key: data.subarray(0, keyLen), iv: data.subarray(keyLen, keyLen + ivLen) };
}

/**
 * Encrypt the way the SPA's `CryptoJS.AES.encrypt(plaintext, passphrase)`
 * does: fresh random 8-byte salt, MD5 EVP_BytesToKey -> 32-byte key + 16-byte
 * IV, AES-256-CBC/PKCS7, wire format base64("Salted__" + salt + ciphertext).
 */
export function moglixEncrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, ciphertext]).toString("base64");
}

/** Inverse of `moglixEncrypt` — same scheme as the SPA's `CryptoJS.AES.decrypt`. */
export function moglixDecrypt(blob: string, passphrase: string): string {
  const buf = Buffer.from(blob, "base64");
  const magic = buf.subarray(0, 8).toString("utf8");
  if (magic !== "Salted__") throw new Error(`moglix: ciphertext missing "Salted__" magic (got ${JSON.stringify(magic)})`);
  const salt = buf.subarray(8, 16);
  const ciphertext = buf.subarray(16);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function randomHexKey(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Unwrap the SPA's single-dynamic-key envelope `{[randomHexKey]: value}` —
 * used for both the encrypted request body and the encrypted response body.
 * The request's key name and the response's key name are unrelated (each
 * side generates its own), so this just requires exactly one entry rather
 * than checking a specific key.
 */
const EnvelopeSchema = z.record(z.string(), z.string());

export function unwrapEnvelope(json: unknown): string {
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`moglix: expected a string-valued envelope object: ${JSON.stringify(parsed.error.issues.slice(0, 2))}`);
  }
  const values = Object.values(parsed.data);
  if (values.length !== 1) {
    throw new Error(`moglix: expected exactly one key in envelope, got ${values.length}`);
  }
  const value = values[0];
  if (value === undefined) {
    throw new Error("moglix: envelope value unexpectedly missing");
  }
  return value;
}

export const MoglixJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  job_title: z.string(),
  date_posted: z.string().nullable().optional(),
  job_category: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  job_type: z.string().nullable().optional(),
  employee_status: z.string().nullable().optional(),
  jd: z.string().nullable().optional(),
  business_unit_name: z.string().nullable().optional(),
});
export type MoglixJob = z.infer<typeof MoglixJobSchema>;

const ListPayloadSchema = z.object({
  data: z.object({
    rows: z.array(MoglixJobSchema),
  }),
});

/** Decrypt+validate one `careers/list` response envelope into its job rows. */
export function parseListResponse(envelopeJson: unknown, passphrase: string): MoglixJob[] {
  const ciphertext = unwrapEnvelope(envelopeJson);
  const plaintext = moglixDecrypt(ciphertext, passphrase);
  const parsed = ListPayloadSchema.parse(JSON.parse(plaintext));
  return parsed.data.rows;
}

/** Moglix's `date_posted` is "DD-MM-YYYY" (confirmed live). Null on malformed input. */
export function parseDdMmYyyy(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (Number.isNaN(iso.getTime())) return null;
  return iso.toISOString();
}

export function normalizeMoglix(company: AdapterCompany, j: MoglixJob): NormalizedPosting {
  const id = String(j.id);
  const location = j.location ?? null;
  return {
    provider: "moglix",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_title,
    jobUrl: `${CAREERS_URL}?job=${id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.jd),
    postedAt: parseDdMmYyyy(j.date_posted),
  };
}

/**
 * POST the encrypted `careers/list` request. Not routed through
 * `atsFetchJson` because this API requires a bespoke `fe-req-encrypted`
 * header (the envelope's dynamic key name) that helper has no option for;
 * this mirrors its timeout/UA/error semantics directly. No WAF gate observed
 * live — the default bot UA works fine, no cookies/session needed.
 */
async function fetchEncryptedList(): Promise<unknown> {
  const hexKey = randomHexKey();
  const requestBody = { ...GRID_REQUEST, requiresCounts: true, skip: 0, take: TAKE };
  const ciphertext = moglixEncrypt(JSON.stringify(requestBody), ENC_PASSPHRASE);
  const envelope = { [hexKey]: ciphertext };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "User-Agent": config.fetch.userAgent,
        Accept: "application/json",
        "Content-Type": "application/json",
        [REQ_ENC_HEADER]: hexKey,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError("moglix", res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const moglixAdapter: AtsAdapter = {
  provider: "moglix",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await fetchEncryptedList().catch((err: unknown) => {
      logger.warn({ slug: company.slug, err: String(err).slice(0, 200) }, "moglix list fetch failed");
      throw err;
    });
    const rows = parseListResponse(json, ENC_PASSPHRASE);
    return rows.map((j) => normalizeMoglix(company, j));
  },
};
