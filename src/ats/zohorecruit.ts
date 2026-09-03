// src/ats/zohorecruit.ts — Zoho Recruit hosted sites (<tenant>.zohorecruit.com/.in): a plain GET of the careers page returns SSR HTML with the full jobs list as an entity-escaped JSON array in <input id="jobs" value="[...]">, one request, no pagination.
// Most tenants inline the full JD there, but 22 of 57 (2026-08-13 sweep) omit Job_Description; fetchJd then reads the job DETAIL page, where the JD is embedded in a JS-escaped (\x22-quoted) data blob.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText, decodeAttrEntities } from "./htmlText.js";
import { atsFetchText, parseOrThrow } from "./http.js";
import { matchGroup } from "../util/regex.js";
import { tryParseJson } from "../util/json.js";
import { joinLocation } from "./shared.js";

export const ZohoRecruitJobSchema = z.object({
  id: z.string(),
  Posting_Title: z.string(),
  Job_Description: z.string().nullable().optional(),
  City: z.string().nullable().optional(),
  State: z.string().nullable().optional(),
  Country: z.string().nullable().optional(),
  Remote_Job: z.boolean().nullable().optional(),
  Date_Opened: z.string().nullable().optional(),
  // Live boards only embed Publish:true jobs; filtered defensively anyway.
  Publish: z.boolean().nullable().optional(),
  Job_Type: z.string().nullable().optional(),
});
export type ZohoRecruitJob = z.infer<typeof ZohoRecruitJobSchema>;

const JobsIslandSchema = z.array(ZohoRecruitJobSchema);

// Pulls the raw (still entity-escaped) value of the id="jobs" hidden input; attribute values are fully entity-escaped so raw quotes only occur as delimiters, making a quote-aware scan for the tag-closing > unambiguous. Null when absent.
export function extractJobsIsland(html: string): string | null {
  // A raw id="jobs" literal can occur in unrelated page content before the real island, so walk every occurrence and require containment in an <input> tag.
  for (let idIdx = html.indexOf('id="jobs"'); idIdx !== -1; idIdx = html.indexOf('id="jobs"', idIdx + 1)) {
    const tagStart = html.lastIndexOf("<input", idIdx);
    if (tagStart === -1) continue;

    let end = -1;
    let inQuote = false;
    for (let i = tagStart; i < html.length; i++) {
      const ch = html[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ">" && !inQuote) { end = i; break; }
    }
    if (end === -1) continue;
    // Containment: a stray literal in earlier content has its nearest <input further back, so that tag closes before the occurrence — skip it.
    if (end <= idIdx) continue;

    // `\s` (not `\b`) so a data-value="..." attribute can never match.
    const value = matchGroup(/\svalue="([^"]*)"/, html.slice(tagStart, end + 1));
    if (value !== null) return value;
  }
  return null;
}

// Entity-decode + JSON-parse + zod-validate the island.
export function parseJobsIsland(raw: string, slug: string): ZohoRecruitJob[] {
  const json = tryParseJson(decodeAttrEntities(raw));
  if (json === null) {
    throw new Error(`zohorecruit jobs island is not valid JSON for ${slug} (serialization change?)`);
  }
  return parseOrThrow(JobsIslandSchema, json, { provider: "zohorecruit", slug, what: "jobs island" });
}

// Board-style detail URL: the server routes on the id alone (any/no slug still 200s), so the slug just needs to be close.
export function zohoJobUrl(company: AdapterCompany, j: ZohoRecruitJob): string {
  const base = company.careersUrl.replace(/\/+$/, "");
  const titleSlug = j.Posting_Title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return titleSlug ? `${base}/${j.id}/${titleSlug}` : `${base}/${j.id}`;
}

export function normalizeZohoRecruit(company: AdapterCompany, j: ZohoRecruitJob): NormalizedPosting {
  return {
    provider: "zohorecruit",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.Posting_Title,
    jobUrl: zohoJobUrl(company, j),
    location: joinLocation(j.City, j.State, j.Country),
    isRemote: j.Remote_Job === true,
    jdText: htmlToText(j.Job_Description),
    postedAt: j.Date_Opened ?? null,
  };
}

// Full HTML -> postings path, exposed so tests cover it without HTTP.
export function postingsFromZohoHtml(company: AdapterCompany, html: string): NormalizedPosting[] {
  const raw = extractJobsIsland(html);
  if (raw === null) {
    throw new Error(
      `zohorecruit: no id="jobs" island at ${company.careersUrl} for ${company.slug} — wrong page path or layout change`,
    );
  }
  return parseJobsIsland(raw, company.slug)
    .filter((j) => j.Publish !== false)
    .map((j) => normalizeZohoRecruit(company, j));
}

// Pulls the JD from a job DETAIL page's hex-escaped JS string (\x22Job_Description\x22:\x22<span...); the value's own inner quotes are escaped one layer deeper, so the first bare (non-backslash-preceded) \x22 after the value opens is the terminator. Null when there's no JD value.
export function extractZohoDetailJd(html: string): string | null {
  const OPEN = "\\x22:\\x22";
  let i = html.indexOf("Job_Description");
  while (i !== -1) {
    if (html.startsWith(OPEN, i + "Job_Description".length)) break;
    i = html.indexOf("Job_Description", i + 1);
  }
  if (i === -1) return null;
  const valueStart = i + "Job_Description".length + OPEN.length;
  let j = valueStart;
  for (;;) {
    j = html.indexOf("\\x22", j);
    if (j === -1) return null;
    if (html[j - 1] !== "\\") break;
    j += 4;
  }
  let s = html.slice(valueStart, j);
  // Unescape layers in order: \xNN hex, \uNNNN unicode, then one pass of simple JS escapes.
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
  return s;
}

export const zohorecruitAdapter: AtsAdapter = {
  provider: "zohorecruit",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(company.careersUrl, { provider: "zohorecruit" });
    return postingsFromZohoHtml(company, html);
  },

  // Called only for postings whose list island carried no JD.
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "zohorecruit" });
    const jd = extractZohoDetailJd(html);
    return jd === null ? "" : htmlToText(jd);
  },
};
