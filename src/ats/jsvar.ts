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
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { dig } from "./nextdata.js";

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

/** Slice out a bracket-balanced literal starting at the first `open` bracket
 *  after `startMarker`. Tracks string state so brackets inside quoted values
 *  (incl. backtick strings) don't miscount. Returns null if unbalanced. */
export function extractBalanced(text: string, startMarker: string, open: "[" | "{"): string | null {
  const markerAt = text.indexOf(startMarker);
  if (markerAt < 0) return null;
  const start = text.indexOf(open, markerAt + startMarker.length);
  if (start < 0) return null;
  const close = open === "[" ? "]" : "}";

  let depth = 0;
  let quote: string | null = null; // ' " or `
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse an extracted literal. JSON.parse for escaped-JSON blobs; a sandboxed
 *  vm eval for JS object/array literals (single quotes, backticks, bare keys). */
export function parseLiteral(literal: string, viaJson: boolean): unknown {
  if (viaJson) return JSON.parse(literal) as unknown;
  const sandbox = createContext(Object.create(null) as object);
  return runInContext(`(${literal})`, sandbox, { timeout: 1000 });
}

function digString(value: unknown, path: string): string | null {
  const v = dig(value, path);
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function jdFrom(job: unknown, fields: string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = dig(job, f);
    if (typeof v === "string" && v.trim()) parts.push(v);
    else if (Array.isArray(v)) for (const it of v) if (typeof it === "string" && it.trim()) parts.push(it);
  }
  return parts.length ? htmlToText(parts.join("\n")) : "";
}

/** Pull the raw text to search: assetUrl body, else the HTML (marker may live
 *  in an inline <script> or a raw flight string, so search the whole doc). */
export function jsVarSourceText(html: string, cfg: JsVarConfig): string {
  if (cfg.assetUrl) return html; // caller already fetched the asset into `html`
  // Inline case: search raw HTML (covers <script> literals and flight blobs).
  return html;
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
  const entries: Array<{ key: string | null; job: unknown }> =
    cfg.container === "object" && parsed && typeof parsed === "object"
      ? Object.entries(parsed as Record<string, unknown>).map(([key, job]) => ({ key, job }))
      : Array.isArray(parsed)
        ? parsed.map((job) => ({ key: null, job }))
        : [];

  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  for (const { key, job } of entries) {
    const jobTitle = digString(job, cfg.titleField);
    if (!jobTitle) continue;
    const rawId = cfg.idField ? digString(job, cfg.idField) : null;
    const externalId =
      key ?? rawId ?? jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
      jdText: jdFrom(job, cfg.jdFields),
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
      return jsVarPostings(company, jsVarSourceText(text, cfg));
    } catch (e) {
      logger.warn({ slug: company.slug, err: String(e).slice(0, 160) }, "jsvar parse failed");
      throw e;
    }
  },
};
