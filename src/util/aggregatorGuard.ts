import type { NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

const AGGREGATOR_ORG_THRESHOLD = 10;

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
  sample: string[];
}

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
