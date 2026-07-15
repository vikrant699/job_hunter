// src/ats/workline.ts — Workline HR, a shared multi-tenant Indian ATS built on
// classic ASP.NET WebMethods (<tenant>.workline.hr). Verified live 2026-07-15
// against tenant `bluestar` (Blue Star Limited).
//
//   list: POST https://<tenant>.workline.hr/CPortal/generalopening.aspx/GetCurrentopening
//         header Content-Type: application/json
//         body   {"JDFileName":"1","OrgCode":"","KeyName":"","Type":"D","StateCode":""}
//         -> {"d":{"__type":"CurrentOpeningData","obj1":"<JSON-encoded array string>","obj2":"..."}}
//         `d.obj1` is a *string* holding a JSON array of job rows — it must be
//         JSON.parse'd a second time (parseWorklineListEnvelope does both
//         steps + schema validation). `d.obj2` is unrelated UI metadata
//         (org/filter field labels) and is ignored.
//         No offset/skip/take fields exist on this endpoint and the tenant's
//         own frontend (GeneralOpenings.js) requests it exactly once with no
//         paging params — confirmed live: two independent calls returned the
//         same 355/355 rows with matching TrackTokens, so this is a single-shot
//         full list, not a paginated one. No pagination loop is implemented.
//
//   detail/apply page (also used as jobUrl): a server-rendered page at
//         https://<tenant>.workline.hr/CandidatePortal/<TrackToken>/<SearchKeyWord>
//         (SearchKeyWord URI-encoded). TrackToken + SearchKeyWord come straight
//         off the list row and were confirmed stable across repeat list calls.
//
//   JD: the detail page DOES render an inline HTML "Job Description" block
//         (<div class="description-info">...<p>...</p></div>) plus
//         Qualifications/Experience <li> lines in a "Short Info" panel —
//         confirmed live on multiple jobs, including ones whose listing
//         JobSpecificationFile was empty. So the primary JD source is this
//         inline HTML, extracted + stripped by extractWorklineDetailJd.
//         The JobSpecificationFile/MRFDetailFile fields are a PDF (rendered
//         client-side via pdf.js against
//         /CPortal/CanPRFApply.aspx?ModeFlag=V&filename=<file>) — we do NOT
//         parse that PDF. It's kept only as a last-resort fallback: if a
//         future/edge posting's detail page renders no description-info block
//         at all, fetchJd composes a minimal deterministic JD text from
//         whatever's still recoverable (posting title/location + the same
//         detail page's hidden PDF filename, when present) via
//         composeWorklineFallbackJd, so the posting is never dropped as
//         "no-jd". Business name and vacancy count aren't present on the
//         detail page itself, so the live fallback path leaves them
//         null/company-name-only; composeWorklineFallbackJd's full field set
//         (title, business, location, vacancies, pdf url) is exercised
//         directly in tests via worklineFallbackInputFromJob against a raw
//         listing row, matching the field list this was speced against.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE } from "./shared.js";

/** One row of the (double-JSON-encoded) `d.obj1` array. Only the fields this
 *  adapter consumes are validated — the live payload carries several more
 *  (PRFCode, ERFCode, GradeName, JobExp_from/To, Walkin*, ...) that are
 *  irrelevant here and pass through unvalidated (zod drops unknown keys). */
export const WorklineJobSchema = z.object({
  Req_No: z.union([z.string(), z.number()]),
  Position_Name: z.string(),
  PublishDate: z.string().nullable().optional(),
  No_Of_Vacancies: z.number().nullable().optional(),
  business_name: z.string().nullable().optional(),
  Company_Name: z.string().nullable().optional(),
  JobSpecificationFile: z.string().nullable().optional(),
  MRFDetailFile: z.string().nullable().optional(),
  City_Name: z.string().nullable().optional(),
  LOCATIONNAME: z.string().nullable().optional(),
  LOCATIONNAME1: z.string().nullable().optional(),
  State: z.string().nullable().optional(),
  state_name: z.string().nullable().optional(),
  Country_Name: z.string().nullable().optional(),
  TrackToken: z.string().nullable().optional(),
  SearchKeyWord: z.string().nullable().optional(),
});
export type WorklineJob = z.infer<typeof WorklineJobSchema>;

/** The raw `GetCurrentopening` envelope — `d.obj1` is itself a JSON string,
 *  not a nested object, hence z.string() here (see parseWorklineListEnvelope). */
const WorklineEnvelopeSchema = z.object({
  d: z.object({
    __type: z.string().nullable().optional(),
    obj1: z.string(),
    obj2: z.string().nullable().optional(),
  }),
});

const LIST_BODY = { JDFileName: "1", OrgCode: "", KeyName: "", Type: "D", StateCode: "" };

/** Build the tenant's `GetCurrentopening` WebMethod URL. */
export function worklineListUrl(tenant: string): string {
  return `https://${tenant}.workline.hr/CPortal/generalopening.aspx/GetCurrentopening`;
}

/** Build the candidate-facing job detail/apply page URL (also the public jobUrl). */
export function worklineDetailUrl(tenant: string, trackToken: string, searchKeyWord: string): string {
  return `https://${tenant}.workline.hr/CandidatePortal/${trackToken}/${encodeURIComponent(searchKeyWord)}`;
}

/** Fallback jobUrl when a row is missing TrackToken/SearchKeyWord (not observed live, but defensive). */
export function worklineRootUrl(tenant: string): string {
  return `https://${tenant}.workline.hr/`;
}

/** Build the PDF viewer URL for a JobSpecificationFile/MRFDetailFile filename
 *  (rendered client-side via pdf.js in the real portal; we never parse it). */
export function worklinePdfUrl(tenant: string, filename: string): string {
  return `https://${tenant}.workline.hr/CPortal/CanPRFApply.aspx?ModeFlag=V&filename=${encodeURIComponent(filename)}`;
}

/** Parse+validate the `GetCurrentopening` envelope, unwrapping the
 *  double-JSON-encoded `d.obj1` string into its job-row array. */
export function parseWorklineListEnvelope(raw: unknown): WorklineJob[] {
  const envelope = WorklineEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`workline: envelope failed schema: ${JSON.stringify(envelope.error.issues.slice(0, 2))}`);
  }
  let inner: unknown;
  try {
    inner = JSON.parse(envelope.data.d.obj1);
  } catch {
    throw new Error("workline: d.obj1 was not valid JSON");
  }
  const jobs = z.array(WorklineJobSchema).safeParse(inner);
  if (!jobs.success) {
    throw new Error(`workline: d.obj1 rows failed schema: ${JSON.stringify(jobs.error.issues.slice(0, 2))}`);
  }
  return jobs.data;
}

/** Compose "City, State, Country" from whichever fields are present,
 *  preferring the (more current-seeming, per live inspection) LOCATIONNAME
 *  fields over City_Name, and deduping adjacent equal parts. */
export function worklineLocation(job: WorklineJob): string | null {
  const city =
    (job.LOCATIONNAME && job.LOCATIONNAME.trim()) ||
    (job.LOCATIONNAME1 && job.LOCATIONNAME1.trim()) ||
    (job.City_Name && job.City_Name.trim()) ||
    null;
  const state = (job.State && job.State.trim()) || (job.state_name && job.state_name.trim()) || null;
  const country = (job.Country_Name && job.Country_Name.trim()) || null;
  const parts = [city, state, country].filter((s): s is string => s !== null && s !== "");
  const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
  return deduped.length > 0 ? deduped.join(", ") : null;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "14-Jul-2026" -> ISO. Null on absent/unparseable input. */
export function parseWorklinePublishDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  if (!dd || !mon || !yyyy) return null;
  const month = MONTH_INDEX[mon];
  if (month === undefined) return null;
  const ms = Date.UTC(Number(yyyy), month, Number(dd));
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function normalizeWorklineJob(company: AdapterCompany, job: WorklineJob): NormalizedPosting {
  const location = worklineLocation(job);
  const jobUrl =
    job.TrackToken && job.SearchKeyWord
      ? worklineDetailUrl(company.slug, job.TrackToken, job.SearchKeyWord)
      : worklineRootUrl(company.slug);
  return {
    provider: "workline",
    externalId: String(job.Req_No),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: job.Position_Name,
    jobUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: parseWorklinePublishDate(job.PublishDate),
  };
}

// ---- JD: primary (inline HTML on the detail page) + deterministic fallback ----

const DESCRIPTION_RE = /<div class="description-info">([\s\S]*?)<div class="requirements">/i;
const QUALIFICATIONS_LI_RE = /<li>[\s\S]*?Qualifications:[\s\S]*?<\/li>/i;
const EXPERIENCE_LI_RE = /<li>[\s\S]*?Experience:[\s\S]*?<\/li>/i;
const HIDDEN_JD_FILE_RE = /id="hideJobSpecificationFile"[^>]*value="([^"]*)"/i;

/** Extract the inline JD (description + qualifications + experience) from a
 *  CandidatePortal detail page's HTML. Returns "" if none of those blocks are
 *  present (signals the caller to use the deterministic fallback instead). */
export function extractWorklineDetailJd(html: string): string {
  const parts: string[] = [];
  const desc = DESCRIPTION_RE.exec(html);
  if (desc) parts.push(desc[1]!);
  const qual = QUALIFICATIONS_LI_RE.exec(html);
  if (qual) parts.push(qual[0]);
  const exp = EXPERIENCE_LI_RE.exec(html);
  if (exp) parts.push(exp[0]);
  return htmlToText(parts.join("\n"));
}

/** Pull the candidate-visible PDF filename (`hideJobSpecificationFile` hidden
 *  input) out of a detail page's HTML, if the server rendered one. */
export function extractWorklineHiddenPdfFilename(html: string): string | null {
  const m = HIDDEN_JD_FILE_RE.exec(html);
  const val = m?.[1]?.trim();
  return val ? val : null;
}

export interface WorklineJdFallbackInput {
  jobTitle: string;
  business: string | null;
  location: string | null;
  vacancies: number | null;
  pdfUrl: string | null;
}

/** Minimal deterministic JD text for the (not observed live, but speced-for)
 *  case where a posting has no inline HTML description at all — only a PDF.
 *  Always yields non-empty text (jobTitle is the one field guaranteed present). */
export function composeWorklineFallbackJd(input: WorklineJdFallbackInput): string {
  const lines = [
    input.jobTitle,
    `Business: ${input.business ?? "n/a"}`,
    `Location: ${input.location ?? "n/a"}`,
    `Vacancies: ${input.vacancies ?? "n/a"}`,
  ];
  if (input.pdfUrl) lines.push(`Full JD: ${input.pdfUrl}`);
  return lines.join("\n");
}

/** Build a WorklineJdFallbackInput straight from a raw listing row (the
 *  Position_Name/Business/location/No_Of_Vacancies/pdf-url field set this was
 *  speced against) — used directly by tests; fetchJd's live fallback path
 *  builds a narrower version of this from posting fields + the detail page's
 *  hidden PDF filename, since business/vacancies aren't present there. */
export function worklineFallbackInputFromJob(job: WorklineJob, tenant: string): WorklineJdFallbackInput {
  const pdfFile =
    (job.JobSpecificationFile && job.JobSpecificationFile.trim()) ||
    (job.MRFDetailFile && job.MRFDetailFile.trim()) ||
    "";
  return {
    jobTitle: job.Position_Name,
    business: job.Company_Name ?? job.business_name ?? null,
    location: worklineLocation(job),
    vacancies: job.No_Of_Vacancies ?? null,
    pdfUrl: pdfFile ? worklinePdfUrl(tenant, pdfFile) : null,
  };
}

export const worklineAdapter: AtsAdapter = {
  provider: "workline",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(worklineListUrl(company.slug), {
      method: "POST",
      body: LIST_BODY,
      provider: "workline",
    });
    const jobs = parseWorklineListEnvelope(raw);
    return jobs.map((j) => normalizeWorklineJob(company, j));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "workline" });
    const primary = extractWorklineDetailJd(html);
    if (primary) return primary;

    // Defensive fallback — see module header. Never throws so a posting whose
    // detail page renders no description block isn't dropped as "no-jd".
    const pdfFile = extractWorklineHiddenPdfFilename(html);
    return composeWorklineFallbackJd({
      jobTitle: posting.jobTitle,
      business: company.name,
      location: posting.location,
      vacancies: null,
      pdfUrl: pdfFile ? worklinePdfUrl(company.slug, pdfFile) : null,
    });
  },
};
