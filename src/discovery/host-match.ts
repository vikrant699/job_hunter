// Filters out aggregator / VC-portfolio pages that mention the company name
// but aren't on the company's own domain. Tokens <4 chars are skipped to
// avoid acronym false positives. Shared by brave.ts and rss.ts so both
// sources apply the same precision bar.
export function hostMatchesName(host: string, name: string): boolean {
  const hostLower = host.toLowerCase().replace(/^www\./, "");
  const tokens = name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  // For very short names like "MPL" / "ABB", fall back to a 3-char prefix check
  if (tokens.length === 0) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return compact.length >= 3 && hostLower.includes(compact);
  }
  return tokens.some((t) => hostLower.includes(t));
}
