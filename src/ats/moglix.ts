// list: POST moglix-api.flexiele.com/api-pub/rec/careers/list, request/response AES-256-CBC encrypted (CryptoJS OpenSSL-compatible "Salted__" KDF) with a static passphrase, wrapped in a random-hex-key envelope echoed as the fe-req-encrypted header
// take:50000 fetches the whole board in one POST; JD inline on every row, no fetchJd
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const API_URL = "https://moglix-api.flexiele.com/api-pub/rec/careers/list";
const CAREERS_URL = "https://moglix.flexiele.com/careers/moglix/jobs";
const REQ_ENC_HEADER = "fe-req-encrypted";

// Re-derive by grepping a fresh bundle for `reqEncKey:"` if this ever 403s/decrypt-fails.
const ENC_PASSPHRASE = "2e35f242a46d67eeb74aabc37d5e5d05";

const EMPTY_SORT: readonly string[] = [];
const GRID_REQUEST = { formCode: "FRM0001379", gridCode: "GRD0000837", sorted: EMPTY_SORT };
const TAKE = 50000; // the real client requests the same in one shot

// CryptoJS's EvpKDF (MD5-based EVP_BytesToKey): derive keyLen+ivLen bytes via repeated MD5(prev+passphrase+salt).
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

// matches CryptoJS.AES.encrypt(plaintext, passphrase): random 8-byte salt, EVP_BytesToKey -> 32-byte key + 16-byte IV, AES-256-CBC/PKCS7, base64("Salted__" + salt + ciphertext)
export function moglixEncrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, ciphertext]).toString("base64");
}

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

// request/response envelope keys are unrelated (each side generates its own); just require exactly one entry, not a specific key
const EnvelopeSchema = z.record(z.string(), z.string());

export function unwrapEnvelope(json: JsonValue): string {
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
export function parseListResponse(envelopeJson: JsonValue, passphrase: string): MoglixJob[] {
  const ciphertext = unwrapEnvelope(envelopeJson);
  const plaintext = moglixDecrypt(ciphertext, passphrase);
  const parsed = ListPayloadSchema.parse(JSON.parse(plaintext));
  return parsed.data.rows;
}

// Moglix's date_posted is "DD-MM-YYYY". Null on malformed input.
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

// No WAF gate observed live — the default bot UA works fine, no cookies/session needed.
async function fetchEncryptedList(): Promise<JsonValue> {
  const hexKey = randomHexKey();
  const requestBody = { ...GRID_REQUEST, requiresCounts: true, skip: 0, take: TAKE };
  const ciphertext = moglixEncrypt(JSON.stringify(requestBody), ENC_PASSPHRASE);
  const envelope = { [hexKey]: ciphertext };
  return atsFetchJson(API_URL, {
    method: "POST",
    body: envelope,
    provider: "moglix",
    headers: { [REQ_ENC_HEADER]: hexKey },
  });
}

export const moglixAdapter: AtsAdapter = {
  provider: "moglix",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    const json = await fetchEncryptedList().catch((err: unknown) => {
      logger.warn({ slug: company.slug, err: String(err).slice(0, 200) }, "moglix list fetch failed");
      throw err;
    });
    const rows = parseListResponse(json, ENC_PASSPHRASE);
    return rows.map((j) => normalizeMoglix(company, j));
  },
};
