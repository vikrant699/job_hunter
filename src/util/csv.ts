function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCsvCell(h)).join(","));
  for (const row of rows) {
    lines.push(row.map((c) => escapeCsvCell(c)).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Minimal RFC-4180 CSV parser: handles quoted fields, doubled-quote escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else if (c === "\r" && text[i + 1] === "\n") {
        // Normalize CRLF inside quoted fields to \n (the \n is appended next pass).
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore; newline handling happens on \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
