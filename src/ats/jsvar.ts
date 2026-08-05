// src/ats/jsvar.ts — generic adapter for careers pages that ship their job
// list as a JS literal (or an escaped-JSON blob) baked into the page HTML,
// rather than a JSON island or an API. Verified live on WazirX
// (`const JOB_DATA = {...}` in a .js file), EaseMyTrip (`const ROLES = [...]`
// inline), Ramco (`jobData = [...]` with backtick values), and Revolt
// (`\"initialJobs\":[...]` inside a Next.js RSC flight string).
//
// Per-company config in apiMeta (all strings):
//   listUrl        optional — defaults to tenantUrl/careersUrl.
//   assetUrl       optional — a SEPARATE URL to fetch the literal from (e.g.
//                  WazirX's /js/jobs.js), when it isn't inline in listUrl.
//   startMarker    REQUIRED — literal text immediately before the value, e.g.
//                  "const JOB_DATA =", "const ROLES =", "jobData =",
//                  '\"initialJobs\":' (for the escaped-flight case).
//   open           REQUIRED — "[" or "{": the value's opening bracket.
//   unescape       optional ("true") — JSON-unescape (\" -> ", \\ -> \) the
//                  whole source BEFORE locating the literal (for RSC-flight
//                  blobs). With this set, give startMarker in its UNESCAPED
//                  form, e.g. "\"initialJobs\":" written as '"initialJobs":'.
//   container      optional — "array" (default) or "object": when "object",
//                  the parsed value is a { id: job } map whose VALUES are the
//                  jobs (WazirX) and whose KEY is used as the externalId.
//   titleField / idField / locationField / jdFields / fixedLocation:
//                  same dot-path mapping semantics as the nextdata adapter.
//   urlTemplate    optional — {id}/{slug} placeholders; defaults to listUrl.
//
// Parsing: JS literals with single quotes / backticks / unquoted keys aren't
// JSON, so the extracted text is evaluated in a locked-down `vm` context (no
// globals, 1s timeout) — safe because the sandbox has nothing to reach and
// the input is a data literal. Escaped-JSON blobs (unescape:true) go through
// JSON.parse instead.
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
    fixedLocation: m.fixedLocation ?? null,
  };
}

/** Parse an extracted literal. JSON.parse for escaped-JSON blobs; a sandboxed
 *  vm eval for JS object/array literals (single quotes, backticks, bare keys).
 *
 *  The vm branch is the one boundary here whose input is JavaScript, not JSON: a
 *  scraped literal may legitimately hold `undefined`, array holes (`['a',,'c']`),
 *  `NaN`, or a Date — none of which JsonValue can represent, and all of which a
 *  real careers page has shipped. So that branch is normalised through JSON
 *  first, which is precisely what the same data would look like had it arrived
 *  over the wire (undefined/functions dropped, holes and NaN -> null, Date ->
 *  ISO string). Validating the raw eval result instead would reject literals
 *  this adapter parsed fine before — see the parseLiteral tests. */
export function parseLiteral(literal: string, viaJson: boolean): JsonValue {
  if (viaJson) return JsonValueSchema.parse(JSON.parse(literal));
  const sandbox = createContext({ __proto__: null });
  return JsonValueSchema.parse(
    JSON.parse(JSON.stringify(runInContext(`(${literal})`, sandbox, { timeout: 1000 }))),
  );
}

export function jsVarPostings(company: AdapterCompany, sourceText: string): NormalizedPosting[] {
  const cfg = jsVarConfig(company);
  // For escaped-JSON blobs, unescape the whole source first so the bracket
  // scanner sees real `"` string delimiters (a scanner run over `\"`-escaped
  // text miscounts brackets inside string values).
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

    const slug = digString(job, "slug") ?? externalId;
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
