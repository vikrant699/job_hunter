/** Per-run notification dedup key; location is included so multi-city openings aren't collapsed. */
export function notifyKey(
  company: string,
  title: string | null,
  location: string | null,
): string {
  const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(company)}|${norm(title)}|${norm(location)}`;
}
