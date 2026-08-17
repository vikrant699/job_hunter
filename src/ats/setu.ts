// src/ats/setu.ts — Setu (setu.co, Pine Labs group) careers SPA, fed by a public CSV in a GitHub content repo (SetuHQ/website-content). `Link` is the public TurboHire job page; `Description` is a login-walled Google Doc, never used.
// The CSV carries no location (fixed HQ string used instead); JD comes from the TurboHire page's schema.org JobPosting JSON-LD block.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { matchGroup } from "../util/regex.js";
import { kebabCase } from "../util/slug.js";

export const SETU_CSV_URL =
  "https://raw.githubusercontent.com/SetuHQ/website-content/main/careers/Setu%20Website%20-%20CurrentOpenings.csv";

// Setu HQ (Bangalore); the CSV has no per-role location field.
export const SETU_LOCATION = "Bengaluru, India";

// Hand-rolled CSV parser (no new dependency); handles quoted fields (commas or doubled "" quotes), CRLF/LF, and blank lines.
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
      // Swallow bare \r; \n ends the row regardless.
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

/** Maps columns by header name (not position) so reordering upstream can't silently corrupt data; throws if a column is missing. */
export function parseSetuCsv(text: string): SetuRow[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new Error("setu: empty CSV");
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const colIndex: Partial<Record<keyof SetuRow, number>> = {};
  for (const [headerKey, field] of Object.entries(HEADER_KEYS)) {
    const idx = header.indexOf(headerKey);
    if (idx === -1) throw new Error(`setu: CSV missing expected column "${headerKey}"`);
    colIndex[field] = idx;
  }
  // Every field was assigned an index above (or the loop threw) - this never actually throws, it just gives TS a non-undefined number.
  const col = (field: keyof SetuRow): number => {
    const idx = colIndex[field];
    if (idx === undefined) throw new Error(`setu: internal: column index for "${field}" not resolved`);
    return idx;
  };

  const out: SetuRow[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue;
    const record = {
      role: (cells[col("role")] ?? "").trim(),
      description: (cells[col("description")] ?? "").trim(),
      link: (cells[col("link")] ?? "").trim(),
      category: (cells[col("category")] ?? "").trim(),
      subCategory: (cells[col("subCategory")] ?? "").trim(),
    };
    const parsed = SetuRowSchema.safeParse(record);
    if (parsed.success && parsed.data.role && parsed.data.link) out.push(parsed.data);
  }
  return out;
}

const TURBOHIRE_CODE_RE = /\/get\/([^/?#]+)/;

/** TurboHire job code from the Link URL (…/get/<code>); falls back to a kebab-cased role when the URL doesn't match. */
export function setuExternalId(row: SetuRow): string {
  return matchGroup(TURBOHIRE_CODE_RE, row.link) ?? kebabCase(row.role);
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

// TurboHire job pages server-render a schema.org JobPosting JSON-LD island whose `description` is already plain text; falls back to stripping the whole page if it's absent/malformed.
export function extractSetuJdText(html: string): string {
  const [job] = extractJsonLdJobs(html);
  if (job?.description) return htmlToText(job.description);
  return htmlToText(html);
}

export const setuAdapter: AtsAdapter = {
  provider: "setu",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const csv = await atsFetchText(SETU_CSV_URL, { provider: "setu" });
    if (!csv.trim()) throw new Error("setu: CSV response was empty");
    const rows = parseSetuCsv(csv);
    if (rows.length === 0) throw new Error("setu: CSV parsed to zero rows");
    logger.info({ count: rows.length }, "setu: parsed CSV listing");
    return rows.map((row) => normalizeSetuRow(company, row));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    // WAF-fronted TurboHire tenant expects a browser UA, not the default bot UA.
    const html = await atsFetchText(posting.jobUrl, { provider: "setu", userAgent: BROWSER_UA });
    return extractSetuJdText(html);
  },
};
