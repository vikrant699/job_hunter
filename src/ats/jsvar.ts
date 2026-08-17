// src/ats/jsvar.ts — generic adapter for careers pages that ship jobs as a JS literal or escaped-JSON
// blob baked into HTML/a JS asset (verified on WazirX, EaseMyTrip, Ramco, Revolt). Per-company config
// lives in apiMeta (see JsVarConfig).
// JS literals (single quotes/backticks/unquoted keys) aren't valid JSON, so the extracted text runs in a
// locked-down `vm` context (no globals, 1s timeout); escaped-JSON blobs (unescape:true) go through JSON.parse instead.
import { createContext, runInContext } from "node:vm";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, extractBalanced } from "./shared.js";
import { digString, jdFromFields } from "./nextdata.js";
import { kebabCase } from "../util/slug.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

export interface JsVarConfig {
  listUrl: string;
  assetUrl: string | null;
  startMarker: string;
  open: "[" | "{";
  unescape: boolean;
  container: "array" | "object";
  titleField: string;
  idField: string | null;
  locationField: string | null;
  jdFields: string[];
  urlTemplate: string | null;
  slugField: string | null;
  fixedLocation: string | null;
}

export function jsVarConfig(company: AdapterCompany): JsVarConfig {
  const m = company.apiMeta ?? {};
  if (!m.startMarker) throw new Error(`jsvar requires apiMeta.startMarker for ${company.slug}`);
  if (!m.titleField) throw new Error(`jsvar requires apiMeta.titleField for ${company.slug}`);
  const open = m.open === "{" ? "{" : "[";
  return {
    listUrl: m.listUrl ?? company.tenantUrl ?? company.careersUrl,
    assetUrl: m.assetUrl ?? null,
    startMarker: m.startMarker,
    open,
    unescape: m.unescape === "true",
    container: m.container === "object" ? "object" : "array",
    titleField: m.titleField,
    idField: m.idField ?? null,
    locationField: m.locationField ?? null,
    jdFields: m.jdFields ? m.jdFields.split(",").map((s) => s.trim()).filter(Boolean) : [],
    urlTemplate: m.urlTemplate ?? null,
    slugField: m.slugField ?? null,
    fixedLocation: m.fixedLocation ?? null,
  };
}

/** Parse an extracted literal: JSON.parse for escaped-JSON blobs, sandboxed vm eval for JS literals
 *  (single quotes/backticks/bare keys). The vm branch's eval result may hold undefined/array
 *  holes/NaN/Date (none of which JsonValue represents), so it's round-tripped through JSON first to
 *  normalize it the way real wire JSON would (holes/NaN -> null, Date -> ISO string) rather than
 *  rejecting literals that parsed fine before. */
export function parseLiteral(literal: string, viaJson: boolean): JsonValue {
  if (viaJson) return JsonValueSchema.parse(JSON.parse(literal));
  const sandbox = createContext({ __proto__: null });
  return JsonValueSchema.parse(
    JSON.parse(JSON.stringify(runInContext(`(${literal})`, sandbox, { timeout: 1000 }))),
  );
}

export function jsVarPostings(company: AdapterCompany, sourceText: string): NormalizedPosting[] {
  const cfg = jsVarConfig(company);
  // For escaped-JSON blobs, unescape the whole source first so the bracket scanner sees real `"`
  // delimiters (a scanner over `\"`-escaped text miscounts brackets inside string values).
  const haystack = cfg.unescape
    ? sourceText.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\\//g, "/")
    : sourceText;
  const text = extractBalanced(haystack, cfg.startMarker, cfg.open);
  if (!text) throw new Error(`jsvar: startMarker "${cfg.startMarker}" not found for ${company.slug}`);

  const parsed = parseLiteral(text, cfg.unescape);
  let entries: Array<{ key: string | null; job: JsonValue }> = [];
  if (cfg.container === "object") {
    const rec = z.record(z.string(), JsonValueSchema).safeParse(parsed);
    if (rec.success) entries = Object.entries(rec.data).map(([key, job]) => ({ key, job }));
  } else {
    const arr = z.array(JsonValueSchema).safeParse(parsed);
    if (arr.success) entries = arr.data.map((job) => ({ key: null, job }));
  }

  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  for (const { key, job } of entries) {
    const jobTitle = digString(job, cfg.titleField);
    if (!jobTitle) continue;
    const rawId = cfg.idField ? digString(job, cfg.idField) : null;
    const externalId = key ?? rawId ?? kebabCase(jobTitle);
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);

    const slug =
      (cfg.slugField ? digString(job, cfg.slugField) : null) ?? digString(job, "slug") ?? externalId;
    const jobUrl = cfg.urlTemplate
      ? cfg.urlTemplate.replace("{id}", externalId).replace("{slug}", slug)
      : cfg.listUrl;
    const location = (cfg.locationField ? digString(job, cfg.locationField) : null) ?? cfg.fixedLocation;

    out.push({
      provider: "jsvar",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: jdFromFields(job, cfg.jdFields),
      postedAt: null,
    });
  }
  return out;
}

export const jsvarAdapter: AtsAdapter = {
  provider: "jsvar",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cfg = jsVarConfig(company);
    const url = cfg.assetUrl ?? cfg.listUrl;
    const text = await atsFetchText(url, { provider: "jsvar" });
    try {
      return jsVarPostings(company, text);
    } catch (e) {
      logger.warn({ slug: company.slug, err: String(e).slice(0, 160) }, "jsvar parse failed");
      throw e;
    }
  },
};
