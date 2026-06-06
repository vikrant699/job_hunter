import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { upsertCompany } from "../db/index.js";
import { isDeniedCompany } from "../filter/denylist.js";
import type { Provider, ParsingStrategy, CompanyStatus, RegistryEntry } from "../types.js";
import { RegistryEntrySchema } from "../types.js";
import { kebabCase, resolveSlug } from "../util/slug.js";

const RegistryFileSchema = z.array(RegistryEntrySchema);

function readRegistryFile(path: string): RegistryEntry[] {
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

export function syncRegistryFromJson(): { synced: number; denied: number; registryPath: string } {
  const path = resolve(process.cwd(), config.storage.registryPath);
  const entries = readRegistryFile(path);

  // Single source of truth. Map dedups in case the file carries duplicate keys.
  const merged = new Map<string, RegistryEntry>();
  for (const e of entries) merged.set(`${e.source}::${resolveSlug(e)}`, e);

  const now = new Date().toISOString();
  let denied = 0;

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

  logger.info({ registryPath: path, count: merged.size, denied }, "registry synced");
  return { synced: merged.size, denied, registryPath: path };
}
