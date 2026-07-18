// src/ats/nextdata.ts — generic adapter for Next.js (pages-router) careers
// pages that SSR-embed their full job list in the <script id="__NEXT_DATA__">
// JSON island (verified live on Awign, Park+, Redcliffe Labs). Per-company
// config in apiMeta (all strings):
//
//   listUrl        optional — page to fetch; defaults to tenantUrl/careersUrl.
//   jobsPath       REQUIRED — dot-path from the parsed island's root to the
//                  jobs ARRAY, e.g. "props.pageProps.data.getJobList.results"
//                  or "props.initialState.career_details.data.data.leads".
//   titleField     REQUIRED — dot-path within one job object to the title.
//   idField        optional — dot-path to a stable id (default: titleField slug).
//   locationField  optional — dot-path to a location string.
//   jdFields       optional — comma-separated dot-paths whose string/string[]
//                  values are concatenated as the JD text.
//   urlTemplate    optional — job URL template with {id} / {slug} placeholders
//                  ({slug} reads the job's "slug"/"attributes.slug" field);
//                  defaults to the list page URL.
//   fixedLocation  optional — fallback location when locationField is absent.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { kebabCase } from "../util/slug.js";

export interface NextDataConfig {
  listUrl: string;
  jobsPath: string;
  titleField: string;
  idField: string | null;
  locationField: string | null;
  jdFields: string[];
  urlTemplate: string | null;
  fixedLocation: string | null;
}

export function nextDataConfig(company: AdapterCompany): NextDataConfig {
  const meta = company.apiMeta ?? {};
  if (!meta.jobsPath) throw new Error(`nextdata requires apiMeta.jobsPath for ${company.slug}`);
  if (!meta.titleField) throw new Error(`nextdata requires apiMeta.titleField for ${company.slug}`);
  return {
    listUrl: meta.listUrl ?? company.tenantUrl ?? company.careersUrl,
    jobsPath: meta.jobsPath,
    titleField: meta.titleField,
    idField: meta.idField ?? null,
    locationField: meta.locationField ?? null,
    jdFields: meta.jdFields ? meta.jdFields.split(",").map((s) => s.trim()).filter(Boolean) : [],
    urlTemplate: meta.urlTemplate ?? null,
    fixedLocation: meta.fixedLocation ?? null,
  };
}

/** Walk a dot-path into a nested unknown value; null when any hop is missing. */
export function dig(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = Reflect.get(cur, key);
  }
  return cur ?? null;
}

/** dig() a path and coerce the hit to a trimmed string (numbers stringified). */
export function digString(value: unknown, path: string): string | null {
  const v = dig(value, path);
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

/** Extract and parse the __NEXT_DATA__ island from a page's HTML. */
export function parseNextDataIsland(html: string): unknown {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").first().text();
  if (!raw) throw new Error("nextdata: page has no __NEXT_DATA__ script tag");
  return JSON.parse(raw);
}

/** Concatenate the string/string[] values at `fields` dot-paths as JD text. */
export function jdFromFields(job: unknown, fields: string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = dig(job, f);
    if (typeof v === "string" && v.trim()) parts.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && item.trim()) parts.push(item);
    }
  }
  // Fields may carry HTML; normalize to text like other adapters do.
  return parts.length > 0 ? htmlToText(parts.join("\n")) : "";
}

export function nextDataPostings(company: AdapterCompany, island: unknown): NormalizedPosting[] {
  const cfg = nextDataConfig(company);
  const arr = dig(island, cfg.jobsPath);
  if (!Array.isArray(arr)) {
    throw new Error(`nextdata: jobsPath "${cfg.jobsPath}" did not resolve to an array for ${company.slug}`);
  }

  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  for (const job of arr) {
    const jobTitle = digString(job, cfg.titleField);
    if (!jobTitle) continue;

    const rawId = cfg.idField ? digString(job, cfg.idField) : null;
    const externalId = rawId ?? kebabCase(jobTitle);
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);

    const slug = digString(job, "slug") ?? digString(job, "attributes.slug") ?? externalId;
    const jobUrl = cfg.urlTemplate
      ? cfg.urlTemplate.replace("{id}", externalId).replace("{slug}", slug)
      : cfg.listUrl;

    const location =
      (cfg.locationField ? digString(job, cfg.locationField) : null) ?? cfg.fixedLocation;

    out.push({
      provider: "nextdata",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: jdFromFields(job, cfg.jdFields),
      postedAt: digString(job, "attributes.publishedAt") ?? digString(job, "createdAt"),
    });
  }
  return out;
}

export const nextdataAdapter: AtsAdapter = {
  provider: "nextdata",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cfg = nextDataConfig(company);
    const html = await atsFetchText(cfg.listUrl, { provider: "nextdata" });
    return nextDataPostings(company, parseNextDataIsland(html));
  },
};
