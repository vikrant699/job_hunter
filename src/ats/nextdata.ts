// src/ats/nextdata.ts — generic adapter for Next.js (pages-router) careers pages that SSR-embed
// their full job list in the <script id="__NEXT_DATA__"> JSON island. Per-company config in apiMeta:
// listUrl (optional), jobsPath (required, dot-path to the jobs array), titleField (required),
// idField/locationField/jdFields/urlTemplate/fixedLocation (all optional, see nextDataConfig).
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
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

// Walk a tokenized dot-path into a nested JsonValue; null when any hop is missing or malformed.
export function dig(node: JsonValue, path: readonly string[]): JsonValue | null {
  let cur: JsonValue = node;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return null;
    const next: JsonValue | undefined = Array.isArray(cur)
      ? (/^\d+$/.test(key) ? cur[Number(key)] : undefined)
      : cur[key];
    if (next === undefined) return null;
    cur = next;
  }
  return cur;
}

export function digString(value: JsonValue, path: string): string | null {
  const v = dig(value, path.split("."));
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

// Throws if the script tag is absent or its body isn't valid JSON.
export function parseNextDataIsland(html: string): JsonValue {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").first().text();
  if (!raw) throw new Error("nextdata: page has no __NEXT_DATA__ script tag");
  return JsonValueSchema.parse(JSON.parse(raw));
}

export function jdFromFields(job: JsonValue, fields: string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = dig(job, f.split("."));
    if (typeof v === "string" && v.trim()) parts.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && item.trim()) parts.push(item);
    }
  }
  return parts.length > 0 ? htmlToText(parts.join("\n")) : "";
}

export function nextDataPostings(company: AdapterCompany, island: JsonValue): NormalizedPosting[] {
  const cfg = nextDataConfig(company);
  const dug = dig(island, cfg.jobsPath.split("."));
  // Some tenants group jobs as an object of department -> array rather than one flat array.
  const arr = Array.isArray(dug)
    ? dug
    : dug !== null && typeof dug === "object"
      ? Object.values(dug).flatMap((v) => (Array.isArray(v) ? v : []))
      : null;
  if (!Array.isArray(arr)) {
    throw new Error(`nextdata: jobsPath "${cfg.jobsPath}" did not resolve to an array (or object of arrays) for ${company.slug}`);
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
