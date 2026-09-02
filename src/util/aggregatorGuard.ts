import type { NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

/** A single company's board should return postings from that one org; more than this many distinct
 *  companyName values means it's actually an agency/aggregator board. */
const AGGREGATOR_ORG_THRESHOLD = 10;

/** Counts distinct non-empty companyName values, case-insensitive and trimmed. For most adapters
 *  companyName equals the registry company name on every posting, so this is 1 — only multi-org
 *  boards like agency adapters produce variety. */
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

/** Threshold check + payload for the "board looks like an aggregator" warn, so the scheduler only has to
 *  log what this returns. Null when the listing's org count is within a single-company board's range. */
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
