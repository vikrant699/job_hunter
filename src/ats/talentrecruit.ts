// src/ats/talentrecruit.ts — TalentRecruit career boards (Zepto, Voltas, ...).
//
// The channel is browser-backed + encrypted:
//   1. Load https://<tenant>.talentrecruit.com/career-page (boots the Angular
//      SPA; the jobs API is tenant-gated by a `shortname` header the SPA adds —
//      a bare fetch 500s "cannot read account").
//   2. In-page fetch GET app.api.talentrecruit.com/api/v1/career/template/job/list
//      ?limit=200&offset=N  with header  shortname: https://<tenant>.talentrecruit.com
//      Paginate by offset until noOfTotalRecords.count is reached (limit max 200).
//   3. Each response body is a TweetNaCl `box` blob {text, iv, key}; decrypt with
//      the global backend seed -> JSON envelope { data: { data: {
//      noOfTotalRecords:{count}, data:[jobs] } } }. Each job carries its full
//      description inline (no per-job fetch).
//
// SELF-HEALING SEED: the 32-byte seed lives in the tenant's main.<hash>.js
// bundle; the hash changes each redeploy. We cache bundleHash->seed on disk and
// only re-extract from the bundle on a cache miss (or when a cached seed fails
// to decrypt). The hardcoded default below is a last-resort fallback only, so a
// value rotation self-repairs on the next run instead of returning silent zeros.
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import nacl from "tweetnacl";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { logger } from "../logger.js";
import { htmlToText } from "./htmlText.js";
import { withAtsTimeout } from "./http.js";
import { REMOTE_RE, tenantOrigin, joinLocation } from "./shared.js";
import { browserCaptureText } from "./browserFetch.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { config } from "../config.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

// ---- constants ----

/** Global backend seed (32 bytes), verified identical across tenants 2026-07-10.
 *  LAST-RESORT default only — runtime prefers the seed extracted from the live
 *  bundle (see {@link resolveSeed}). */
export const DEFAULT_SEED: readonly number[] = [
  98, 89, 42, 106, 113, 112, 94, 50, 73, 100, 114, 53, 108, 83, 52, 52,
  87, 73, 89, 98, 75, 56, 121, 90, 57, 86, 68, 86, 94, 68, 85, 113,
];

const API_ORIGIN = "https://app.api.talentrecruit.com";
const JOB_LIST_PATH = "/api/v1/career/template/job/list";
const PAGE_LIMIT = 200; // server caps limit at 200
const SEED_CACHE_PATH = "data/talentrecruit-seed.json";

// ---- crypto (pure) ----

export function seedBytes(seed: readonly number[]): Uint8Array {
  return Uint8Array.from(seed);
}

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

/** {text=ciphertext, key=nonce, iv=sender ephemeral public key} — TalentRecruit's
 *  field naming is intentionally misleading; the mapping below is the verified one. */
export const EncryptedBlobSchema = z.object({
  text: z.string(),
  iv: z.string(),
  key: z.string(),
});
export type EncryptedBlob = z.infer<typeof EncryptedBlobSchema>;

/** Low-level NaCl box open. Returns null when the seed is wrong (or the blob is
 *  corrupt) — callers use null to trigger a seed re-extraction. */
export function boxOpen(blob: EncryptedBlob, seed: Uint8Array): Uint8Array | null {
  return nacl.box.open(b64ToBytes(blob.text), b64ToBytes(blob.key), b64ToBytes(blob.iv), seed);
}

/** Decrypt a blob to parsed JSON. Returns null iff box.open fails (wrong seed).
 *  Throws only if decryption succeeds but the plaintext is not valid JSON — a
 *  genuinely different failure that re-extracting the seed would not fix. */
export function decryptToJson(blob: EncryptedBlob, seed: Uint8Array): JsonValue | null {
  const opened = boxOpen(blob, seed);
  if (!opened) return null;
  const text = Buffer.from(opened).toString("utf8");
  return JsonValueSchema.parse(JSON.parse(text));
}

// ---- seed extraction from the client bundle (pure) ----

const SEED_RE = /backendseed\s*:\s*\{\s*secretKey\s*:\s*\[([0-9,\s]+)\]/;

/** Pull the 32-byte seed array out of a `main.<hash>.js` bundle. Null if absent. */
export function extractSeedFromBundle(js: string): number[] | null {
  const m = js.match(SEED_RE);
  if (!m || !m[1]) return null;
  const nums = m[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
  return nums.length === 32 ? nums : null;
}

/** The seed-bearing bundle is served from the tenant host as `main.<hash>.js`.
 *  Pick that URL from the observed response list; the hash is the cache key. */
export function bundleUrlFromResponses(urls: string[], tenantHost: string): string | null {
  const onHost = urls.filter((u) => u.includes(tenantHost) && /\/main\.[0-9a-f]+\.js(?:\?|$)/i.test(u));
  if (onHost[0]) return onHost[0];
  // Fallback: any main.<hash>.js anywhere (still carries the same global seed).
  return urls.find((u) => /\/main\.[0-9a-f]+\.js(?:\?|$)/i.test(u)) ?? null;
}

/** Stable cache key for a bundle URL — its filename (`main.<hash>.js`). */
export function bundleKey(bundleUrl: string): string {
  return bundleUrl.split("/").pop()?.split("?")[0] ?? bundleUrl;
}

// ---- seed store + self-healing resolution ----

export interface SeedStore {
  get(key: string): number[] | undefined;
  set(key: string, seed: number[]): void;
}

/** File-backed seed cache (data/talentrecruit-seed.json). data/ is gitignored;
 *  the cache is a runtime artifact, safe to delete (it re-extracts on miss). */
export function fileSeedStore(path: string = SEED_CACHE_PATH): SeedStore {
  const read = (): Record<string, number[]> => {
    try {
      const parsed: JsonValue = JsonValueSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      const schema = z.record(z.string(), z.array(z.number()));
      const r = schema.safeParse(parsed);
      return r.success ? r.data : {};
    } catch {
      return {};
    }
  };
  return {
    get(key) { return read()[key]; },
    set(key, seed) {
      const all = read();
      all[key] = seed;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(all, null, 2), "utf8");
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 120) }, "talentrecruit: seed cache write failed");
      }
    },
  };
}

/**
 * Resolve the decryption seed for a bundle: cache hit returns it without any
 * network; a miss (or `force`) fetches the bundle once, extracts + caches the
 * seed. Falls back to {@link DEFAULT_SEED} (logged) if extraction fails, so a
 * variable rename surfaces as a warning rather than a hard crash.
 */
export async function resolveSeed(
  key: string,
  fetchBundle: () => Promise<string>,
  store: SeedStore,
  opts: { force?: boolean } = {},
): Promise<Uint8Array> {
  if (!opts.force) {
    const cached = store.get(key);
    if (cached && cached.length === 32) return seedBytes(cached);
  }
  const js = await fetchBundle();
  const extracted = extractSeedFromBundle(js);
  if (extracted) {
    store.set(key, extracted);
    return seedBytes(extracted);
  }
  logger.warn({ key }, "talentrecruit: seed not found in bundle — falling back to default seed");
  return seedBytes(DEFAULT_SEED);
}

/**
 * Decrypt with self-healing: try the cached seed, then a forced re-extraction,
 * then the hardcoded default. Throws (loud) only if all three fail — that means
 * TalentRecruit changed the scheme, not just rotated the value.
 */
export async function decryptWithHealing(
  blob: EncryptedBlob,
  key: string,
  fetchBundle: () => Promise<string>,
  store: SeedStore,
): Promise<JsonValue> {
  const cached = await resolveSeed(key, fetchBundle, store);
  const first = decryptToJson(blob, cached);
  if (first !== null) return first;

  logger.warn({ key }, "talentrecruit: cached seed failed to decrypt — re-extracting");
  const fresh = await resolveSeed(key, fetchBundle, store, { force: true });
  const second = decryptToJson(blob, fresh);
  if (second !== null) return second;

  const fallback = decryptToJson(blob, seedBytes(DEFAULT_SEED));
  if (fallback !== null) {
    logger.warn({ key }, "talentrecruit: decrypted with default seed after extraction failed");
    return fallback;
  }
  throw new Error("talentrecruit: decrypt failed after seed re-extraction — encryption scheme likely changed");
}

// ---- job list envelope (pure) ----

export const TalentRecruitJobSchema = z.object({
  jobid: z.union([z.string(), z.number()]).nullable().optional(),
  code: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  joblocation: z.string().nullable().optional(),
  officelocation: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  isremotejob: z.union([z.number(), z.boolean()]).nullable().optional(),
  publishedtime: z.string().nullable().optional(),
  createdtime: z.string().nullable().optional(),
});
export type TalentRecruitJob = z.infer<typeof TalentRecruitJobSchema>;

const JobListEnvelopeSchema = z.object({
  data: z.object({
    data: z.object({
      noOfTotalRecords: z.object({ count: z.number().nullable().optional() }).nullable().optional(),
      data: z.array(TalentRecruitJobSchema),
    }),
  }),
});

export interface JobListPage {
  jobs: TalentRecruitJob[];
  total: number | null;
}

/** Unwrap the decrypted `{data:{data:{noOfTotalRecords,data:[...]}}}` envelope. */
export function parseJobListPage(decrypted: JsonValue): JobListPage {
  const parsed = JobListEnvelopeSchema.parse(decrypted);
  return {
    jobs: parsed.data.data.data,
    total: parsed.data.data.noOfTotalRecords?.count ?? null,
  };
}

// ---- normalize (pure) ----

export function normalizeTalentRecruit(company: AdapterCompany, j: TalentRecruitJob): NormalizedPosting {
  const location = (j.joblocation && j.joblocation.trim())
    || (j.officelocation && j.officelocation.trim())
    || joinLocation(j.city, j.state, j.country);
  // `code` is the stable requisition code; `jobid` is a per-request AES token, so
  // prefer code for the dedup key.
  const externalId = String(
    (j.code !== null && j.code !== undefined && j.code !== "" && j.code)
    || (j.jobid !== null && j.jobid !== undefined && j.jobid),
  );
  const isRemote = j.isremotejob === 1 || j.isremotejob === true
    || (location ? REMOTE_RE.test(location) : false);
  return {
    provider: "talentrecruit",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: (j.title ?? "").trim(),
    jobUrl: `${tenantOrigin(company)}/career-page`,
    location,
    isRemote,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.publishedtime ?? j.createdtime ?? null,
  };
}

// ---- orchestration (impure) ----

function jobListUrl(offset: number): string {
  return `${API_ORIGIN}${JOB_LIST_PATH}?limit=${PAGE_LIMIT}&offset=${offset}`;
}

async function fetchBundle(bundleUrl: string): Promise<string> {
  // The bundle is ~25MB; give it well beyond the standard ATS timeout.
  return withAtsTimeout(async (signal) => {
    const res = await fetch(bundleUrl, { headers: { "User-Agent": BROWSER_UA }, signal });
    if (!res.ok) throw new Error(`talentrecruit bundle HTTP ${res.status}`);
    return await res.text();
  }, Math.max(config.fetch.timeoutMs, 60_000));
}

export const talentRecruitAdapter: AtsAdapter = {
  provider: "talentrecruit",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = tenantOrigin(company);
    const tenantHost = new URL(origin).host;
    const careerPage = `${origin}/career-page`;
    const shortname = origin; // the tenant-context header value the SPA sends

    // First page (offset 0) both reveals the total and the bundle URL for the seed.
    const first = await browserCaptureText(careerPage, [
      { url: jobListUrl(0), headers: { shortname } },
    ]);
    const bundleUrl = bundleUrlFromResponses(first.responseUrls, tenantHost);
    if (!bundleUrl) {
      throw new Error(`talentrecruit: no main.<hash>.js bundle observed for ${company.slug}`);
    }
    const key = bundleKey(bundleUrl);
    const store = fileSeedStore();
    const getBundle = () => fetchBundle(bundleUrl);

    const decryptPage = async (bodyText: string): Promise<JobListPage> => {
      const blob = EncryptedBlobSchema.parse(JSON.parse(bodyText));
      const decrypted = await decryptWithHealing(blob, key, getBundle, store);
      return parseJobListPage(decrypted);
    };

    const firstBody = first.bodies[0];
    if (firstBody === undefined) throw new Error(`talentrecruit: empty job-list response for ${company.slug}`);
    const page0 = await decryptPage(firstBody);
    const out: NormalizedPosting[] = page0.jobs.map((j) => normalizeTalentRecruit(company, j));
    const total = page0.total ?? out.length;

    // Remaining pages (rare — only tenants with >200 active jobs) in one more
    // navigation: one browser load, several in-page fetches.
    if (out.length < total && page0.jobs.length > 0) {
      const offsets: number[] = [];
      for (let off = out.length; off < total; off += PAGE_LIMIT) offsets.push(off);
      if (offsets.length > 0) {
        const rest = await browserCaptureText(
          careerPage,
          offsets.map((off) => ({ url: jobListUrl(off), headers: { shortname } })),
        );
        for (const body of rest.bodies) {
          const pageN = await decryptPage(body);
          if (pageN.jobs.length === 0) break;
          for (const j of pageN.jobs) out.push(normalizeTalentRecruit(company, j));
          if (out.length >= total) break;
        }
      }
    }
    return out;
  },
  // The list response carries the full description inline — no fetchJd needed.
};
