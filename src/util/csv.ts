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
