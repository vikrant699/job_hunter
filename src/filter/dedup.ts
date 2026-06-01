/**
 * Per-run notification dedup key. Two postings with the same company, normalized
 * title, and normalized location are treated as the same role (a repost or
 * re-listed requisition with a fresh id) and notified only once. Location is part
 * of the key so a genuinely multi-city opening is NOT collapsed.
 */
export function notifyKey(
  company: string,
  title: string | null,
  location: string | null,
): string {
  const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(company)}|${norm(title)}|${norm(location)}`;
}
