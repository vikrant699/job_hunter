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
