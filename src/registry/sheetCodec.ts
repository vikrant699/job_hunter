import type { RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema, ApiMetaSchema } from "../schemas.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

/** Column contract for the Companies tab; order is load-bearing (entryToRow/rowToEntry index into it) - add new columns at the END. */
export const REGISTRY_COLUMNS = [
  "name",
  "careers_url",
  "source",
  "source_slug",
  "parsing_strategy",
  "status",
  "reason",
  "discovered_via",
  "discovered_at",
  "evidence",
  "tenant_url",
  "api_meta",
  "category",
  "employer_type",
] as const;

/** Serialize a registry entry to one sheet row (strings only; empty = absent). */
export function entryToRow(entry: RegistryEntry): string[] {
  return REGISTRY_COLUMNS.map((col) => {
    const v = entry[col];
    if (v === undefined || v === null) return "";
    if (col === "api_meta") return JSON.stringify(v);
    return String(v);
  });
}

export type RowDecodeResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; issues: string };

/** Decodes one sheet row into a validated RegistryEntry; returns issues instead of throwing so bad rows can be quarantined without aborting the sync. */
export function rowToEntry(row: string[]): RowDecodeResult {
  const candidate: Record<string, string | Record<string, string>> = {};
  for (let i = 0; i < REGISTRY_COLUMNS.length; i++) {
    const col = REGISTRY_COLUMNS[i];
    if (col === undefined) continue;
    const cell = (row[i] ?? "").trim();
    if (cell === "") continue;
    if (col === "api_meta") {
      let parsed: JsonValue;
      try {
        parsed = JsonValueSchema.parse(JSON.parse(cell));
      } catch {
        return { ok: false, issues: `api_meta cell is not valid JSON: ${cell.slice(0, 80)}` };
      }
      const meta = ApiMetaSchema.safeParse(parsed);
      if (!meta.success) {
        return { ok: false, issues: `api_meta must be a JSON object of strings: ${cell.slice(0, 80)}` };
      }
      candidate[col] = meta.data;
    } else {
      candidate[col] = cell;
    }
  }
  const result = RegistryEntrySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, issues };
  }
  return { ok: true, entry: result.data };
}
