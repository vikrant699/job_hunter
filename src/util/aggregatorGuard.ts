import type { NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

/** More than this many distinct companyName values on one board means it's actually an agency/aggregator board, not a single company. */
const AGGREGATOR_ORG_THRESHOLD = 10;

/** Counts distinct non-empty companyName values, case-insensitive and trimmed; usually 1, since companyName equals the registry company name on every posting except on multi-org boards. */
export function countDistinctOrgs(postings: NormalizedPosting[]): number {
  const names = new Set<string>();
  for (const posting of postings) {
    const trimmed = posting.companyName.trim();
    if (trimmed) names.add(trimmed.toLowerCase());
  }
  return names.size;
}

export interface AggregatorWarning {
  provider: Provider;
  slug: string;
  distinctOrgs: number;
  /** First 3 distinct companyName values, in first-seen order (original casing). */
  sample: string[];
}

/** Threshold check + payload for the "board looks like an aggregator" warn; null when the listing's org count is within a single-company board's range. */
export function aggregatorWarning(
  provider: Provider,
  slug: string,
  postings: NormalizedPosting[],
): AggregatorWarning | null {
  const distinctOrgs = countDistinctOrgs(postings);
  if (distinctOrgs <= AGGREGATOR_ORG_THRESHOLD) return null;

  const seen = new Set<string>();
  const sample: string[] = [];
  for (const posting of postings) {
    const trimmed = posting.companyName.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(trimmed);
    if (sample.length >= 3) break;
  }
  return { provider, slug, distinctOrgs, sample };
}
