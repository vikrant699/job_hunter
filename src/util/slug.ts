export function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveSlug(entry: {
  name: string;
  source_slug?: string | null;
}): string {
  if (entry.source_slug && entry.source_slug.length > 0)
    return entry.source_slug;
  return kebabCase(entry.name);
}

/**
 * The dedup/merge/prune key used across the registry pipeline:
 * `${source}::${resolveSlug(entry)}`. Centralized so registry-writer.ts's
 * dedup, registry/companies.ts's merge map, and its prune-diff all agree on
 * identity (previously each derived this independently and could drift).
 */
export function registryKey(entry: {
  name: string;
  source?: string | null;
  source_slug?: string | null;
}): string {
  return `${entry.source ?? "custom"}::${resolveSlug(entry)}`;
}
