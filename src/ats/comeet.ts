// src/ats/comeet.ts — Comeet hosted job boards (www.comeet.com/jobs/<company>/<code>).
// The board page embeds `COMPANY_POSITIONS_DATA = [...];`, a single JSON array with every position and its full
// JD HTML inline (no pagination); fetchJd is a fallback reading the same-shaped `POSITION_DATA = {...};` island off
// the position's own page. Islands are serialized on one line, so extraction greedy-matches to the line's last
// bracket (a literal "];" inside a description can't truncate it), with a lazy multi-line fallback.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, dateToIso } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const ComeetLocationSchema = z.object({
  name: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  is_remote: z.boolean().nullable().optional(),
});
export type ComeetLocation = z.infer<typeof ComeetLocationSchema>;

const ComeetDetailSchema = z.object({
  name: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
});

export const ComeetPositionSchema = z.object({
  uid: z.string(),
  name: z.string(),
  is_internal: z.boolean().nullable().optional(),
  location: ComeetLocationSchema.nullable().optional(),
  url_comeet_hosted_page: z.string().nullable().optional(),
  url_active_page: z.string().nullable().optional(),
  employment_type: z.string().nullable().optional(),
  workplace_type: z.string().nullable().optional(),
  time_updated: z.string().nullable().optional(),
  custom_fields: z
    .object({ details: z.array(ComeetDetailSchema).nullable().optional() })
    .nullable()
    .optional(),
});
export type ComeetPosition = z.infer<typeof ComeetPositionSchema>;

function extractIsland(html: string, varName: string, open: "[" | "{"): JsonValue | null {
  const close = open === "[" ? "]" : "}";
  const esc = (c: string) => `\\${c}`;
  const greedy = new RegExp(`${varName}\\s*=\\s*(${esc(open)}.*${esc(close)});`, "m");
  const lazy = new RegExp(`${varName}\\s*=\\s*(${esc(open)}[\\s\\S]*?${esc(close)});`);
  for (const re of [greedy, lazy]) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    const parsed = tryParseJson(m[1]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractComeetPositions(html: string): JsonValue[] | null {
  const parsed = extractIsland(html, "COMPANY_POSITIONS_DATA", "[");
  return Array.isArray(parsed) ? parsed : null;
}

export function extractComeetPosition(html: string): Record<string, JsonValue> | null {
  const parsed = extractIsland(html, "POSITION_DATA", "{");
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
}

/** "city, name" collapsed to just one when either contains the other, else country. */
export function comeetLocationString(loc: ComeetLocation | null | undefined): string | null {
  if (!loc) return null;
  const city = loc.city?.trim() || null;
  const name = loc.name?.trim() || null;
  let composed: string | null;
  if (city && name) {
    const c = city.toLowerCase();
    const n = name.toLowerCase();
    composed = n.includes(c) ? name : c.includes(n) ? city : `${city}, ${name}`;
  } else {
    composed = city ?? name;
  }
  return composed ?? (loc.country?.trim() || null);
}

/** Plain-text JD from the island's Description/Requirements sections. */
export function comeetJdFromDetails(p: ComeetPosition): string {
  const sections: string[] = [];
  for (const d of p.custom_fields?.details ?? []) {
    if (!d.value) continue;
    const text = htmlToText(d.value);
    if (!text) continue;
    sections.push(d.name ? `${d.name}\n${text}` : text);
  }
  return sections.join("\n\n");
}

export function normalizeComeet(company: AdapterCompany, p: ComeetPosition): NormalizedPosting {
  const location = comeetLocationString(p.location);
  return {
    provider: "comeet",
    externalId: p.uid,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.name,
    jobUrl: p.url_comeet_hosted_page ?? p.url_active_page ?? company.careersUrl,
    location,
    isRemote: p.location?.is_remote === true || REMOTE_RE.test(`${p.workplace_type ?? ""} ${location ?? ""}`),
    jdText: comeetJdFromDetails(p),
    postedAt: dateToIso(p.time_updated),
  };
}

export const comeetAdapter: AtsAdapter = {
  provider: "comeet",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // careersUrl IS the board page (both path segments — company + code — are in it).
    const html = await atsFetchText(company.careersUrl, { provider: "comeet" });
    const raw = extractComeetPositions(html);
    if (!raw) throw new Error(`comeet: no COMPANY_POSITIONS_DATA island for ${company.slug}`);
    const out: NormalizedPosting[] = [];
    for (const item of raw) {
      const parsed = ComeetPositionSchema.safeParse(item);
      // Skip malformed entries (would land with unstable ids) and internal-only roles.
      if (!parsed.success || parsed.data.is_internal === true) continue;
      out.push(normalizeComeet(company, parsed.data));
    }
    return out;
  },

  // Fallback only: the list already carries the full JD for every tenant seen
  // so far. Runs when a tenant's island omitted custom_fields.details.
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "comeet" });
    const island = extractComeetPosition(html);
    if (island === null) return "";
    const parsed = ComeetPositionSchema.safeParse(island);
    return parsed.success ? comeetJdFromDetails(parsed.data) : "";
  },
};
