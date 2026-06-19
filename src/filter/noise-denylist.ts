/**
 * Confirmed-NOISE denylist. Companies here were REMOVED from config/companies.json
 * because they meet the strict noise bar (see docs/superpowers/plans/2026-06-19-
 * registry-expansion-denoise-categorize.md §9): they (i) never hire tech in India
 * and never will, (ii) are not a tech employer at all, or are defunct / mis-seeded
 * / exact duplicates. `isDeniedCompany` checks this so the discovery queue can
 * NEVER re-add them. Keyed by the exact `source_slug` the company had.
 *
 * Each removal is researched + confirmed by hand (web + curl), not by telemetry.
 * Grows one denoise wave at a time. Low/zero scrape yield is NOT grounds for entry.
 */
export const NOISE_DENYLIST_SLUGS: Record<string, string> = {
  // Wave 1 (2026-06-19)
  "lifestyle-international-india": "exact duplicate of lifestyle-international",
  "frapper": "DNS-dead (frapper.in unresolvable); mis-seed, likely typo of Frappe",
  "bharat-ai": "DNS-dead (bharatai.in unresolvable); unverifiable, mis-seed",
  "falcon-ai": "DNS-dead; investment firm, not a tech employer",
  "greenbloks": "DNS-dead; rebranded to an Iceland infra co, no India presence",
  "hyperkraft": "DNS-dead; no India tech presence, mis-seed",
  "entrackr": "startup-news media outlet — does not hire tech roles",
  "leadingx": "Austrian coaching/training consultancy — not India, not a tech product co",
  "lazy-ai": "US-only (Wilmington, DE); no India hiring",
  // Wave 2 (2026-06-19)
  "blinkit": "does not hire publicly — no public careers board (darwinbox tenant errors on jobs API)",
  "grofers": "old name of Blinkit — no public hiring board",
};

/** True if this slug is on the confirmed-noise denylist. */
export function isNoiseSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOISE_DENYLIST_SLUGS, slug.toLowerCase());
}
