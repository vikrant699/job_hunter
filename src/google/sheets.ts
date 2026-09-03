import { z } from "zod";
import { googleFetchJson, requireSpreadsheetId, CellsSchema } from "./rest.js";
import type { RestDeps } from "./rest.js";

function baseUrl(): string {
  return `https://sheets.googleapis.com/v4/spreadsheets/${requireSpreadsheetId()}`;
}

const ValuesResponseSchema = z.object({
  values: CellsSchema.optional(),
});

const ListTabsResponseSchema = z.object({
  sheets: z
    .array(z.object({ properties: z.object({ title: z.string() }) }))
    .default([]),
});

/** GET a tab's full contents as ROWS of string cells. Absent `values` -> []. */
export async function readTab(profileId: string, tab: string, deps: RestDeps = {}): Promise<string[][]> {
  const url = `${baseUrl()}/values/${encodeURIComponent(tab)}?majorDimension=ROWS`;
  const body = await googleFetchJson(profileId, url, {}, deps);
  return ValuesResponseSchema.parse(body).values ?? [];
}

/** Append rows to the end of a tab. */
export async function appendRows(profileId: string, tab: string, rows: string[][], deps: RestDeps = {}): Promise<void> {
  const url = `${baseUrl()}/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW`;
  await googleFetchJson(profileId, url, { method: "POST", body: { values: rows } }, deps);
}

/** Clear a tab, then write header+rows starting at A1. */
export async function rewriteTab(
  profileId: string,
  tab: string,
  header: string[],
  rows: string[][],
  deps: RestDeps = {},
): Promise<void> {
  const clearUrl = `${baseUrl()}/values/${encodeURIComponent(tab)}:clear`;
  await googleFetchJson(profileId, clearUrl, { method: "POST" }, deps);
  const writeUrl = `${baseUrl()}/values/${encodeURIComponent(tab)}!A1?valueInputOption=RAW`;
  await googleFetchJson(profileId, writeUrl, { method: "PUT", body: { values: [header, ...rows] } }, deps);
}

/** List all tab (sheet) titles in the spreadsheet. */
export async function listTabs(profileId: string, deps: RestDeps = {}): Promise<string[]> {
  const url = `${baseUrl()}?fields=sheets.properties.title`;
  const body = await googleFetchJson(profileId, url, {}, deps);
  return ListTabsResponseSchema.parse(body).sheets.map((s) => s.properties.title);
}

/** Create any of `names` that don't already exist as tabs. No-op if all present. */
export async function ensureTabs(profileId: string, names: string[], deps: RestDeps = {}): Promise<void> {
  const existing = new Set(await listTabs(profileId, deps));
  const missing = names.filter((n) => !existing.has(n));
  if (missing.length === 0) return;
  const url = `${baseUrl()}:batchUpdate`;
  await googleFetchJson(
    profileId,
    url,
    {
      method: "POST",
      body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    },
    deps,
  );
}

/** Overwrite a specific A1 range (no clear first — caller controls the range size). */
export async function updateRange(profileId: string, rangeA1: string, rows: string[][], deps: RestDeps = {}): Promise<void> {
  const url = `${baseUrl()}/values/${rangeA1}?valueInputOption=RAW`;
  await googleFetchJson(profileId, url, { method: "PUT", body: { values: rows } }, deps);
}
