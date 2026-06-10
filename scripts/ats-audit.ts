/**
 * Audit llm-scrape / playwright-llm-scrape companies for hidden ATS boards.
 *
 * For every fetchable scrape-strategy company, fetch its careers page, run the
 * ATS pattern detector, and validate hits (slug probe; keka via orgGuid
 * extraction). Buckets:
 *   promotable        — detected + validated; safe to flip to ats-api now
 *   already-covered   — detected (provider, slug) already exists in the DB
 *   needs-tokens      — adapter exists but api_meta tokens can't be auto-derived
 *   detect-failed     — ATS detected but the slug failed validation
 *   no-ats            — nothing detected on the raw page
 *   fetch-failed      — careers page unreachable
 *
 * Usage: node --import tsx scripts/ats-audit.ts
 * Writes data/ats-audit-<yyyy-mm-dd>.json with full per-company results.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../src/db/db.js";
import { selectAllCompanies } from "../src/db/index.js";
import {
  discoverFromUrl, validateCandidate, discoverKekaMeta, type AtsCandidate,
} from "../src/discovery/ats.js";

const CONCURRENCY = 10;

interface AuditRow {
  name: string;
  slug: string;
  strategy: string;
  careersUrl: string;
  bucket: "promotable" | "already-covered" | "needs-tokens" | "detect-failed" | "no-ats" | "fetch-failed";
  detectedProvider: string | null;
  detectedSlug: string | null;
  detectedUrl: string | null;
  total: number | null;
  detail: string | null;
}

const existsStmt = db.prepare("SELECT 1 FROM companies WHERE provider = :provider AND slug = :slug LIMIT 1");
function alreadyInDb(provider: string, slug: string): boolean {
  return existsStmt.get({ provider, slug }) !== undefined;
}

// Same preference order as discovery's pickBestAts.
function pickBest(candidates: AtsCandidate[]): AtsCandidate | null {
  return candidates.find((c) => c.hasAdapter && c.canValidate)
      ?? candidates.find((c) => c.hasAdapter)
      ?? candidates.find((c) => c.canValidate)
      ?? candidates[0] ?? null;
}

async function auditOne(c: { name: string; slug: string; parsingStrategy: string; careersUrl: string }): Promise<AuditRow> {
  const base: Omit<AuditRow, "bucket" | "detail"> = {
    name: c.name, slug: c.slug, strategy: c.parsingStrategy, careersUrl: c.careersUrl,
    detectedProvider: null, detectedSlug: null, detectedUrl: null, total: null,
  };

  let candidates: AtsCandidate[];
  try {
    ({ candidates } = await discoverFromUrl(c.careersUrl));
  } catch (err) {
    return { ...base, bucket: "fetch-failed", detail: String(err).slice(0, 100) };
  }

  const best = pickBest(candidates);
  if (!best) return { ...base, bucket: "no-ats", detail: null };

  const detected = {
    detectedProvider: best.provider,
    detectedSlug: best.slug,
    detectedUrl: best.url,
  };

  if (alreadyInDb(best.provider, best.slug)) {
    return { ...base, ...detected, bucket: "already-covered", detail: `duplicate of ${best.provider}/${best.slug}` };
  }

  if (best.provider === "keka") {
    const meta = await discoverKekaMeta(best);
    return meta
      ? { ...base, ...detected, bucket: "promotable", total: meta.total, detail: `orgGuid=${meta.orgGuid}` }
      : { ...base, ...detected, bucket: "detect-failed", detail: "keka orgGuid extraction/validation failed" };
  }

  if (best.hasAdapter && !best.canValidate) {
    // eightfold (needs apiMeta.domain) / oracle (needs tenant_url + siteNumber)
    return { ...base, ...detected, bucket: "needs-tokens", detail: `${best.provider} needs manual api_meta` };
  }

  if (best.canValidate) {
    const v = await validateCandidate(best);
    if (v.ok) {
      const note = best.hasAdapter ? null : "no adapter yet (detect/validate only)";
      return { ...base, ...detected, bucket: best.hasAdapter ? "promotable" : "needs-tokens", total: v.total, detail: note };
    }
    return { ...base, ...detected, bucket: "detect-failed", detail: v.error };
  }

  return { ...base, ...detected, bucket: "detect-failed", detail: "detect-only provider (no adapter, no validator)" };
}

async function main(): Promise<void> {
  const targets = selectAllCompanies().filter(
    (c) =>
      (c.parsingStrategy === "llm-scrape" || c.parsingStrategy === "playwright-llm-scrape") &&
      c.status !== "denied" && c.status !== "broken",
  );
  console.log(`auditing ${targets.length} scrape-strategy companies (concurrency ${CONCURRENCY})...`);

  const rows: AuditRow[] = [];
  let cursor = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const idx = cursor++;
      const t = targets[idx];
      if (!t) return;
      rows.push(await auditOne(t));
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const byBucket = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const list = byBucket.get(r.bucket) ?? [];
    list.push(r);
    byBucket.set(r.bucket, list);
  }

  console.log("\n=== summary ===");
  for (const [bucket, list] of [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${bucket.padEnd(16)} ${list.length}`);
  }

  console.log("\n=== promotable (validated, ready for ats-api) ===");
  for (const r of byBucket.get("promotable") ?? []) {
    console.log(`  ${r.name} [${r.strategy}] -> ${r.detectedProvider}/${r.detectedSlug}${r.total !== null ? ` (${r.total} jobs)` : ""}`);
  }
  console.log("\n=== already-covered (scrape entry duplicates an existing DB company) ===");
  for (const r of byBucket.get("already-covered") ?? []) {
    console.log(`  ${r.name} [${r.strategy}] -> ${r.detail}`);
  }
  console.log("\n=== needs-tokens ===");
  for (const r of byBucket.get("needs-tokens") ?? []) {
    console.log(`  ${r.name} -> ${r.detectedProvider}/${r.detectedSlug}: ${r.detail ?? ""}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = resolve(process.cwd(), `data/ats-audit-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(rows, null, 2), "utf-8");
  console.log(`\nfull results -> ${outPath}`);
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
