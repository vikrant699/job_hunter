import { z } from "zod";
import type { Provider } from "../schemas.js";
import { db, queryOne } from "./db.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

export interface ShortlistedLink {
  url: string;
  title: string;
}

const ShortlistedLinkSchema = z.object({
  url: z.string(),
  title: z.string(),
});

const LinkCacheRowSchema = z.object({
  links_json: z.string(),
  cached_at: z.string(),
});

export type LinkCacheRow = z.infer<typeof LinkCacheRowSchema>;

const selectLinkCacheStmt = db.prepare(`
  SELECT links_json, cached_at FROM link_cache
  WHERE provider = :provider AND slug = :slug
`);

const upsertLinkCacheStmt = db.prepare(`
  INSERT INTO link_cache (provider, slug, links_json, cached_at)
  VALUES (:provider, :slug, :linksJson, :cachedAt)
  ON CONFLICT(provider, slug) DO UPDATE SET
    links_json = excluded.links_json,
    cached_at  = excluded.cached_at
`);

export function getLinkCache(
  provider: Provider,
  slug: string,
  ttlMs: number,
): ShortlistedLink[] | null {
  const row = queryOne(selectLinkCacheStmt, LinkCacheRowSchema, { provider, slug });
  if (!row) return null;
  const age = Date.now() - new Date(row.cached_at).getTime();
  if (!Number.isFinite(age) || age > ttlMs) return null;
  try {
    const parsed: JsonValue = JsonValueSchema.parse(JSON.parse(row.links_json));
    const result = z.array(ShortlistedLinkSchema).safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function setLinkCache(
  provider: Provider,
  slug: string,
  links: ShortlistedLink[],
): void {
  upsertLinkCacheStmt.run({
    provider,
    slug,
    linksJson: JSON.stringify(links),
    cachedAt: new Date().toISOString(),
  });
}
