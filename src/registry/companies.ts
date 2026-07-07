import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db, upsertCompany, selectAllCompanies, deleteCompany } from "../db/index.js";
import { isDeniedCompany } from "../filter/denylist.js";
import type { Provider, ParsingStrategy, CompanyStatus, RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";
import { resolveSlug, registryKey } from "../util/slug.js";

const RegistryFileSchema = z.array(RegistryEntrySchema);

/**
 * Read+validate a JSON array of RegistryEntry from disk. Shared by the JSON
 * sync path (below) and the sheet-backed cache fallback (sheet-registry.ts),
 * which reads data/registry-cache.json through this same function — the cache
 * is a plain JSON snapshot of the last fully-valid sheet sync.
 */
export function readRegistryFile(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry file ${path} is not valid JSON: ${err}`);
  }
  const result = RegistryFileSchema.safeParse(parsed);
  if (!result.success) {
    logger.error({ path, issues: result.error.issues.slice(0, 5) }, "registry JSON failed schema");
    throw new Error(`registry file ${path} failed validation`);
  }
  return result.data;
}

export interface SyncEntriesResult {
  synced: number;
  denied: number;
  pruned: number;
}

/**
 * Shared upsert+prune core used by both the legacy JSON sync and the new
 * sheet-backed sync. `opts.prune` gates the delete-orphans pass: callers with
 * any unvalidated/quarantined rows must pass `prune: false` so a single bad
 * row in the source can't wipe out companies it doesn't even mention.
 */
export function syncEntries(entries: RegistryEntry[], opts: { prune: boolean }): SyncEntriesResult {
  // Map dedups in case the source carries duplicate keys.
  const merged = new Map<string, RegistryEntry>();
  for (const e of entries) merged.set(registryKey(e), e);

  const now = new Date().toISOString();
  let denied = 0;
  let pruned = 0;

  // Upsert + prune run as one transaction: a crash or thrown error mid-loop
  // must not leave the DB with some companies synced against the new source and
  // others (including prune deletes) still reflecting the old one.
  db.exec("BEGIN");
  try {
    for (const entry of merged.values()) {
      const slug = resolveSlug(entry);
      const deny = isDeniedCompany(entry.name, slug);

      const status: CompanyStatus = entry.status ?? (deny.denied ? "denied" : "candidate");
      if (status === "denied") denied++;

      const provider: Provider = entry.source;
      const parsingStrategy: ParsingStrategy = entry.parsing_strategy;

      upsertCompany({
        provider,
        slug,
        name: entry.name,
        careersUrl: entry.careers_url,
        parsingStrategy,
        status,
        denyReason: entry.reason ?? deny.reason,
        discoveredVia: entry.discovered_via ?? "seed",
        tenantUrl: entry.tenant_url ?? null,
        apiMeta: entry.api_meta ? JSON.stringify(entry.api_meta) : null,
        discoveredAt: now,
      });
    }

    // Prune DB rows no longer in the source-of-truth. Without this, a removed
    // company — or one whose (provider,slug) changed on conversion (e.g. custom →
    // darwinbox) — leaves a stale row the scheduler would still scrape. Skipped
    // entirely when the caller has quarantined rows this run (opts.prune=false).
    if (opts.prune) {
      const valid = new Set(merged.keys());
      for (const c of selectAllCompanies()) {
        if (!valid.has(registryKey({ name: c.name, source: c.provider, source_slug: c.slug }))) {
          deleteCompany(c.provider, c.slug);
          pruned++;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { synced: merged.size, denied, pruned };
}

export function syncRegistryFromJson(): { synced: number; denied: number; pruned: number; registryPath: string } {
  const path = resolve(process.cwd(), config.storage.registryPath);
  const entries = readRegistryFile(path);
  const result = syncEntries(entries, { prune: true });
  logger.info({ registryPath: path, ...result }, "registry synced");
  return { ...result, registryPath: path };
}
