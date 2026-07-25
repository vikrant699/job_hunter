import { readFileSync } from "node:fs";
import { parseCsv } from "../src/util/csv.js";

export interface LoadedLabels {
  /** id (`provider:external_id`) → true if relevant, false if irrelevant. */
  labels: Map<string, boolean>;
  /** rows whose reaction was blank or unrecognized. */
  skipped: number;
}

export function parseLabels(csvText: string): LoadedLabels {
  const cells = parseCsv(csvText);
  const headerRow = cells[0];
  if (!headerRow) return { labels: new Map(), skipped: 0 };

  const header = headerRow.map((h) => h.trim().toLowerCase());
  const idIx = header.indexOf("id");
  const reactIx = header.indexOf("reaction");
  if (idIx === -1 || reactIx === -1) {
    throw new Error("labels CSV must have 'id' and 'reaction' columns");
  }

  const labels = new Map<string, boolean>();
  let skipped = 0;
  for (const row of cells.slice(1)) {
    const id = (row[idIx] ?? "").trim();
    if (!id) continue;
    const r = (row[reactIx] ?? "").trim().toLowerCase();
    if (r === "relevant" || r === "y" || r === "yes") labels.set(id, true);
    else if (r === "irrelevant" || r === "n" || r === "no") labels.set(id, false);
    else skipped++;
  }
  return { labels, skipped };
}

export function loadLabels(path: string): LoadedLabels {
  return parseLabels(readFileSync(path, "utf-8"));
}
