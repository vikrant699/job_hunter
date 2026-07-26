// src/ats/recruiterflow.ts — Recruiterflow career boards, shared origin
// (recruiterflow.com/<slug>/jobs), one path segment per tenant (e.g.
// coinswitch, instamojo, omnify, and Lokal's opaque
// db_fdae8243f06575ca46a3063600388f33). No XHR/GraphQL call is ever made —
// captured 15s of live network traffic and only NewRelic/GA beacons fired.
// The listing is fully server-rendered as data, not markup: the board's bare
// HTML (curl, no JS needed) embeds every posting inline as a plain (non-JSON
// `<script type>`) `<script>` tag:
//
//   <script type="text/javascript">
//     window.jobsList = {"department": [["Brand", [{"apply_link":
//       "coinswitch/jobs/692", "details": "Bengaluru", "employment_type":
//       "Full time", "job_id": 692, "job_name": "Senior Associate - Brand",
//       "last_opened": "2026-06-09T06:46:35+0000", "remote_type": null}]],
//       ...}, "group": [...same shape, same content as "department"...],
//       "location": [...same postings grouped by location instead...]};
//     ...
//   </script>
//
// `department` and `group` are byte-identical (both group by department); we
// read `department` only and flatten+dedup by `job_id`. Client-side JS
// (careers.js) renders the empty `#rf-jobs-list` div from this literal — it
// never needs to fetch anything, which is why no API call was observed.
//
// JD: GET <origin>/<slug>/jobs/<job_id> -> a `<script
// type="application/ld+json">` holds a full schema.org JobPosting, whose
// `description` field is the JD as rich HTML.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/json-ld.js";
import { REMOTE_RE, dateToIso } from "./shared.js";
import { tryParseJson } from "../util/json.js";

const RF_ORIGIN = "https://recruiterflow.com";

/** Tenant slug (path segment) from the company's board URL, e.g.
 *  "https://recruiterflow.com/coinswitch/jobs" -> "coinswitch". Throws on a
 *  URL with no path segment — a genuinely malformed registry entry. */
export function recruiterflowSlug(company: AdapterCompany): string {
  const raw = company.tenantUrl ?? company.careersUrl;
  const { pathname } = new URL(raw);
  const slug = pathname.split("/").filter(Boolean)[0];
  if (!slug) throw new Error(`recruiterflow: cannot derive slug from ${raw}`);
  return slug;
}

/** The board's listing page: <origin>/<slug>/jobs. */
export function recruiterflowListUrl(company: AdapterCompany): string {
  return `${RF_ORIGIN}/${recruiterflowSlug(company)}/jobs`;
}

/** A single posting's detail page: <origin>/<slug>/jobs/<jobId>. */
export function recruiterflowJobUrl(slug: string, jobId: string | number): string {
  return `${RF_ORIGIN}/${slug}/jobs/${jobId}`;
}

const RfJobStubSchema = z.object({
  apply_link: z.string(),
  details: z.string().nullable().optional(),
  employment_type: z.string().nullable().optional(),
  job_id: z.union([z.number(), z.string()]),
  job_name: z.string(),
  last_opened: z.string().nullable().optional(),
  remote_type: z.string().nullable().optional(),
});
export type RfJobStub = z.infer<typeof RfJobStubSchema>;

const RfGroupSchema = z.array(z.tuple([z.string(), z.array(RfJobStubSchema)]));
const RfJobsListSchema = z.object({ department: RfGroupSchema }).passthrough();

/** Scan `text` from an opening `{` at `startIndex` for its matching `}`,
 *  respecting (double-)quoted strings and escapes. Returns the balanced
 *  substring (inclusive) or null if the braces never close. Needed because
 *  `window.jobsList = {...};` can't be pulled out with a naive non-greedy
 *  regex — job descriptions/titles may themselves contain "};" sequences. */
function extractBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

const JOBS_LIST_MARKER = "window.jobsList = ";

/** Extract + flatten the board's inline job-list literal. Dedups by job_id
 *  (the `department` and `location` groupings repeat the same postings).
 *  Returns [] if the marker is absent (empty board / vendor layout change) —
 *  never throws on a missing/empty board, only on a marker present but
 *  malformed (schema mismatch), which the caller logs and surfaces. */
export function parseRecruiterflowJobsList(html: string): RfJobStub[] {
  const markerIndex = html.indexOf(JOBS_LIST_MARKER);
  if (markerIndex === -1) return [];

  const braceIndex = html.indexOf("{", markerIndex);
  if (braceIndex === -1) return [];

  const objectText = extractBalancedObject(html, braceIndex);
  if (!objectText) return [];

  const raw = tryParseJson(objectText);
  if (raw === null) {
    throw new Error("recruiterflow: window.jobsList is present but not valid JSON");
  }

  const parsed = RfJobsListSchema.parse(raw);
  const seen = new Set<string>();
  const stubs: RfJobStub[] = [];
  for (const [, jobs] of parsed.department) {
    for (const job of jobs) {
      const id = String(job.job_id);
      if (seen.has(id)) continue;
      seen.add(id);
      stubs.push(job);
    }
  }
  return stubs;
}

/** Extract the JD body from a job detail page's schema.org JobPosting
 *  `<script type="application/ld+json">` block (shared extractor). Returns ""
 *  if the block is absent, malformed, or has no JobPosting with a title
 *  (vendor layout change) rather than throwing — an empty JD degrades the
 *  posting instead of failing the run. */
export function parseRecruiterflowJd(html: string): string {
  const [job] = extractJsonLdJobs(html);
  return htmlToText(job?.description ?? "");
}

export function normalizeRecruiterflow(company: AdapterCompany, slug: string, job: RfJobStub): NormalizedPosting {
  const location = job.details ?? null;
  const isRemote = !!job.remote_type || (location ? REMOTE_RE.test(location) : false);
  return {
    provider: "recruiterflow",
    externalId: String(job.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: job.job_name,
    jobUrl: recruiterflowJobUrl(slug, job.job_id),
    location,
    isRemote,
    jdText: "",
    postedAt: dateToIso(job.last_opened),
  };
}

export const recruiterflowAdapter: AtsAdapter = {
  provider: "recruiterflow",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = recruiterflowSlug(company);
    const html = await atsFetchText(recruiterflowListUrl(company), { provider: "recruiterflow" });

    let stubs: RfJobStub[];
    try {
      stubs = parseRecruiterflowJobsList(html);
    } catch (err) {
      logger.warn({ slug, err: String(err) }, "recruiterflow list schema mismatch");
      throw new Error(`recruiterflow: unexpected jobsList shape for ${slug}`);
    }

    return stubs.map((job) => normalizeRecruiterflow(company, slug, job));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "recruiterflow" });
    return parseRecruiterflowJd(html);
  },
};
