// src/ats/setu.ts — Setu (setu.co, Pine Labs group), single-company adapter.
// Setu's careers SPA is fed by a public CSV in a GitHub content repo:
//   GET raw.githubusercontent.com/SetuHQ/website-content/main/careers/
//       Setu%20Website%20-%20CurrentOpenings.csv
// Header: Role,Description,Link,Category,Sub-category. `Description` is a
// login-walled Google Doc link — never used. `Link` is the public TurboHire
// job page (https://pinelabsgroup.turbohire.co/get/<code>); <code> is our
// externalId. The CSV carries no location, so we use a fixed HQ string (Setu
// is Bangalore-HQ'd; every JD confirms this) to keep the India location gate
// working. JD text comes from the job page's server-rendered schema.org
// JobPosting JSON-LD block, which holds the full plain-text description.
import { z } from "zod";
import { logger } from "../logger.js";
import { config } from "../config.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsHttpError } from "./http.js";
import { BROWSER_UA } from "../util/user-agent.js";

export const SETU_CSV_URL =
  "https://raw.githubusercontent.com/SetuHQ/website-content/main/careers/Setu%20Website%20-%20CurrentOpenings.csv";

// Setu HQ (Bangalore); the CSV has no per-role location field.
export const SETU_LOCATION = "Bengaluru, India";

// ---------------------------------------------------------------------------
// CSV parsing — small hand-rolled parser (no new dependency). Handles quoted
// fields (which may contain commas or embedded quotes doubled as ""), CRLF or
// LF line endings, and blank lines.
// ---------------------------------------------------------------------------

/** Parse CSV text into rows of raw string cells. Pure, dependency-free. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      // Swallow bare \r; \n (whether it follows or not) ends the row.
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Last field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) endRow();

  // Drop fully-blank rows (e.g. trailing newline produced an empty row).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const SetuRowSchema = z.object({
  role: z.string(),
  description: z.string(),
  link: z.string(),
  category: z.string(),
  subCategory: z.string(),
});
export type SetuRow = z.infer<typeof SetuRowSchema>;

const HEADER_KEYS: Record<string, keyof SetuRow> = {
  role: "role",
  description: "description",
  link: "link",
  category: "category",
  "sub-category": "subCategory",
};

/** Parse the full CSV text into typed rows, mapping by header name (not
 * position) so column reordering in the source doesn't silently corrupt
 * data. Throws if the header is missing an expected column. */
export function parseSetuCsv(text: string): SetuRow[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new Error("setu: empty CSV");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const colIndex: Partial<Record<keyof SetuRow, number>> = {};
  for (const [headerKey, field] of Object.entries(HEADER_KEYS)) {
    const idx = header.indexOf(headerKey);
    if (idx === -1) throw new Error(`setu: CSV missing expected column "${headerKey}"`);
    colIndex[field] = idx;
  }

  const out: SetuRow[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue; // skip blank lines
    const record = {
      role: (cells[colIndex.role!] ?? "").trim(),
      description: (cells[colIndex.description!] ?? "").trim(),
      link: (cells[colIndex.link!] ?? "").trim(),
      category: (cells[colIndex.category!] ?? "").trim(),
      subCategory: (cells[colIndex.subCategory!] ?? "").trim(),
    };
    const parsed = SetuRowSchema.safeParse(record);
    if (parsed.success && parsed.data.role && parsed.data.link) out.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// externalId / slugify
// ---------------------------------------------------------------------------

const TURBOHIRE_CODE_RE = /\/get\/([^/?#]+)/;

/** Slugify a role name for use as a fallback externalId. */
export function slugifyRole(role: string): string {
  return role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** externalId is the TurboHire job code embedded in the Link URL
 * (…/get/<code>); falls back to a slugified role if the URL doesn't match. */
export function setuExternalId(row: SetuRow): string {
  const m = row.link.match(TURBOHIRE_CODE_RE);
  return m ? m[1]! : slugifyRole(row.role);
}

export function normalizeSetuRow(company: AdapterCompany, row: SetuRow): NormalizedPosting {
  return {
    provider: "setu",
    externalId: setuExternalId(row),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: row.role,
    jobUrl: row.link,
    location: SETU_LOCATION,
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
}

// ---------------------------------------------------------------------------
// JD extraction — the TurboHire job page server-renders a schema.org
// JobPosting as a JSON-LD <script> island; its `description` field is
// already plain text (no HTML tags observed live). Fall back to stripping
// the whole page if that island is absent or malformed.
// ---------------------------------------------------------------------------

const JobPostingLdSchema = z.object({
  description: z.string().optional(),
});

/** Extract the JD body from a TurboHire job page's HTML. */
export function extractSetuJdText(html: string): string {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const parsed = JobPostingLdSchema.safeParse(JSON.parse(m[1]!));
      if (parsed.success && parsed.data.description) return htmlToText(parsed.data.description);
    } catch {
      // fall through to whole-page strip
    }
  }
  return htmlToText(html);
}

// ---------------------------------------------------------------------------
// HTTP — a small local fetch helper. Neither atsFetchJson (JSON-only) nor
// atsFetchText (fixed bot UA) fit here: the CSV fetch is plain text off
// GitHub, and the JD fetch must use a browser UA (verified live: a plain bot
// UA is fine for the CSV host, but the job page is served off a WAF-fronted
// TurboHire tenant that expects a browser UA).
// ---------------------------------------------------------------------------

async function fetchText(url: string, userAgent: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: controller.signal });
    if (!res.ok) throw atsHttpError("setu", res.status, await res.text());
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const setuAdapter: AtsAdapter = {
  provider: "setu",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const csv = await fetchText(SETU_CSV_URL, config.fetch.userAgent);
    if (!csv.trim()) throw new Error("setu: CSV response was empty");
    const rows = parseSetuCsv(csv);
    if (rows.length === 0) throw new Error("setu: CSV parsed to zero rows");
    logger.info({ count: rows.length }, "setu: parsed CSV listing");
    return rows.map((row) => normalizeSetuRow(company, row));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await fetchText(posting.jobUrl, BROWSER_UA);
    return extractSetuJdText(html);
  },
};
