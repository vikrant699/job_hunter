// List: load the Angular SPA (a bare fetch 500s without its `shortname` header), then GET app.api.talentrecruit.com/api/v1/career/template/job/list (offset-paged); bodies are TweetNaCl box blobs decrypted with the global seed, JD inline.
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

// DEFAULT_SEED is a last-resort fallback: the real seed lives in the tenant's main.<hash>.js bundle and rotates on redeploy.
export const DEFAULT_SEED: readonly number[] = [
  98, 89, 42, 106, 113, 112, 94, 50, 73, 100, 114, 53, 108, 83, 52, 52,
  87, 73, 89, 98, 75, 56, 121, 90, 57, 86, 68, 86, 94, 68, 85, 113,
];

const API_ORIGIN = "https://app.api.talentrecruit.com";
const JOB_LIST_PATH = "/api/v1/career/template/job/list";
const PAGE_LIMIT = 200; // server caps limit at 200
const SEED_CACHE_PATH = "data/talentrecruit-seed.json";

export function seedBytes(seed: readonly number[]): Uint8Array {
  return Uint8Array.from(seed);
}

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

// {text=ciphertext, key=nonce, iv=sender ephemeral public key}: TalentRecruit's field naming is misleading.
export const EncryptedBlobSchema = z.object({
  text: z.string(),
  iv: z.string(),
  key: z.string(),
});
export type EncryptedBlob = z.infer<typeof EncryptedBlobSchema>;

export function boxOpen(blob: EncryptedBlob, seed: Uint8Array): Uint8Array | null {
  return nacl.box.open(b64ToBytes(blob.text), b64ToBytes(blob.key), b64ToBytes(blob.iv), seed);
}

// Null iff box.open fails (wrong seed); invalid JSON after a successful decrypt throws, since re-extracting wouldn't fix it.
export function decryptToJson(blob: EncryptedBlob, seed: Uint8Array): JsonValue | null {
  const opened = boxOpen(blob, seed);
  if (!opened) return null;
  const text = Buffer.from(opened).toString("utf8");
  return JsonValueSchema.parse(JSON.parse(text));
}

const SEED_RE = /backendseed\s*:\s*\{\s*secretKey\s*:\s*\[([0-9,\s]+)\]/;

export function extractSeedFromBundle(js: string): number[] | null {
  const m = js.match(SEED_RE);
  if (!m || !m[1]) return null;
  const nums = m[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
  return nums.length === 32 ? nums : null;
}

export function bundleUrlFromResponses(urls: string[], tenantHost: string): string | null {
  const onHost = urls.filter((u) => u.includes(tenantHost) && /\/main\.[0-9a-f]+\.js(?:\?|$)/i.test(u));
  if (onHost[0]) return onHost[0];
  return urls.find((u) => /\/main\.[0-9a-f]+\.js(?:\?|$)/i.test(u)) ?? null;
}

export function bundleKey(bundleUrl: string): string {
  return bundleUrl.split("/").pop()?.split("?")[0] ?? bundleUrl;
}

export interface SeedStore {
  get(key: string): number[] | undefined;
  set(key: string, seed: number[]): void;
}

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

export function parseJobListPage(decrypted: JsonValue): JobListPage {
  const parsed = JobListEnvelopeSchema.parse(decrypted);
  return {
    jobs: parsed.data.data.data,
    total: parsed.data.data.noOfTotalRecords?.count ?? null,
  };
}

export function normalizeTalentRecruit(company: AdapterCompany, j: TalentRecruitJob): NormalizedPosting {
  const location = (j.joblocation && j.joblocation.trim())
    || (j.officelocation && j.officelocation.trim())
    || joinLocation(j.city, j.state, j.country);
  // `jobid` is a per-request AES token; the stable requisition `code` is preferred.
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

function jobListUrl(offset: number): string {
  return `${API_ORIGIN}${JOB_LIST_PATH}?limit=${PAGE_LIMIT}&offset=${offset}`;
}

async function fetchBundle(bundleUrl: string): Promise<string> {
  // The bundle is ~25MB; allow well beyond the standard ATS timeout.
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
    const shortname = origin;

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
};
