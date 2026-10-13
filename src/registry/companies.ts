import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { logger } from "../logger.js";
import { db, upsertCompany, selectAllCompanies, deleteCompany } from "../db/index.js";
import { isDeniedCompany } from "../filter/denylist.js";
import type { Provider, ParsingStrategy, CompanyStatus, RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";
import { resolveSlug, registryKey } from "../util/slug.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const RegistryFileSchema = z.array(RegistryEntrySchema);

export function readRegistryFile(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  let parsed: JsonValue;
  try {
    parsed = JsonValueSchema.parse(JSON.parse(raw));
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

export function syncEntries(entries: RegistryEntry[], opts: { prune: boolean }): SyncEntriesResult {
  const merged = new Map<string, RegistryEntry>();
  for (const e of entries) merged.set(registryKey(e), e);

  const now = new Date().toISOString();
  let denied = 0;
  let pruned = 0;

  db.exec("BEGIN");
  try {
    for (const entry of merged.values()) {
      const slug = resolveSlug(entry);
      const deny = isDeniedCompany(entry.name, slug);

      const status: CompanyStatus = entry.status ?? (deny.denied ? "denied" : "active");
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
