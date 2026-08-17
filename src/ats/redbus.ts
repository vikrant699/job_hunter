// src/ats/redbus.ts — redBus careers (MMT-group proxy API).
// POST /careers/api/getJobsList and /careers/api/getJobDesc, both signed with
// a `hash` query param the client computes as
//   sha512("Admindarwinbox@go-mmt.com9ee1f8acd90924a81180267e97609291" + timestampSeconds)
// (lifted from the site's own jobs.bundle.js — helper/career.js). An invalid
// hash isn't rejected with an error status; the server just silently answers
// with an empty Data array, so a WRONG hash is easy to miss — it must be
// computed correctly, even though there's no secret to keep (the salt string
// is shipped in the client bundle). No per-job URL exists (job detail opens
// as an in-page panel, not a route), so jobUrl falls back to the listing page.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";

const BASE = "https://www.redbus.in/careers";
const UID = "TTEO251S99ERCL";
const HASH_SALT = "Admindarwinbox@go-mmt.com9ee1f8acd90924a81180267e97609291";
export const REDBUS_CAREERS_URL = `${BASE}/jobs`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Not a real secret (the salt is public in the JS bundle), but required for the server to return
// real data instead of a silent empty list.
export function redbusHash(timestamp: number): string {
  return createHash("sha512").update(HASH_SALT + timestamp).digest("hex");
}

function redbusSignedUrl(path: string, extraQuery: string, timestamp: number): string {
  const hash = redbusHash(timestamp);
  return `${BASE}/api/${path}?timestamp=${timestamp}&uid=${UID}&hash=${hash}${extraQuery}`;
}

const RedbusJobSchema = z.object({
  job_id: z.string(),
  job_title: z.string(),
  department: z.string().nullable().optional(),
  location: z.array(z.string()).nullable().optional(),
  location_city: z.array(z.string()).nullable().optional(),
  location_country: z.string().nullable().optional(),
  is_remote: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
  job_updated_timestamp: z.string().nullable().optional(),
  job_created_timestamp: z.string().nullable().optional(),
});
export type RedbusJob = z.infer<typeof RedbusJobSchema>;

const RedbusListResponseSchema = z.object({
  Response: z.object({ Data: z.array(RedbusJobSchema) }),
});

const RedbusJobDescSchema = z.object({
  Response: z.object({
    Data: z.object({
      data: z.object({
        job_decription: z.string().nullable().optional(),
      }),
    }),
  }),
});

export function parseRedbusTimestamp(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const iso = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

export function redbusJobsListUrl(): string {
  return redbusSignedUrl("getJobsList", "", nowSeconds());
}

export function redbusJobDescUrl(jobId: string): string {
  return redbusSignedUrl("getJobDesc", `&jobid=${encodeURIComponent(jobId)}`, nowSeconds());
}

export function normalizeRedbus(company: AdapterCompany, j: RedbusJob): NormalizedPosting {
  const location = j.location?.[0] ?? j.location_city?.[0] ?? j.location_country ?? null;
  return {
    provider: "redbus",
    externalId: j.job_id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_title,
    jobUrl: REDBUS_CAREERS_URL,
    location,
    isRemote: j.is_remote === 1 || (location ? REMOTE_RE.test(location) : false),
    jdText: "",
    postedAt: parseRedbusTimestamp(j.job_updated_timestamp ?? j.job_created_timestamp),
  };
}

export const redbusAdapter: AtsAdapter = {
  provider: "redbus",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(redbusJobsListUrl(), {
      method: "POST",
      body: {},
      provider: "redbus",
      userAgent: BROWSER_UA,
    });
    const parsed = RedbusListResponseSchema.parse(raw);
    return parsed.Response.Data.map((j) => normalizeRedbus(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(redbusJobDescUrl(posting.externalId), {
      method: "POST",
      body: { job_id: posting.externalId },
      provider: "redbus",
      userAgent: BROWSER_UA,
    });
    const parsed = RedbusJobDescSchema.parse(raw);
    const desc = parsed.Response.Data.data.job_decription ?? "";
    // API double-encodes: the field is HTML-entity-encoded HTML (e.g.
    // "&lt;p&gt;...&lt;/p&gt;"), same pattern as darwinbox — decode entities
    // once to get real HTML, then strip tags to plain text.
    return htmlToText(htmlToText(desc));
  },
};
