/**
 * Apply promotions from an ats-audit JSON (scripts/ats-audit.ts output).
 *
 *   node --import tsx scripts/ats-promote.ts data/ats-audit-2026-06-10.json [--apply]
 *
 * Without --apply it's a dry run: prints the plan and exits.
 *
 * - "promotable" rows: dedup by detected (provider, slug) — multiple registry
 *   companies often share one board (Spinny/Truebil/Spinny Cars). The shortest
 *   company name becomes the board's display name; every old scrape entry is
 *   retired as denied/superseded.
 * - "already-covered" rows: old scrape entry retired (board exists in DB).
 * - "needs-tokens" rows (eightfold/oracle): attempt automatic token extraction
 *   (oracle siteNumber from the /sites/CX_n path; eightfold domain= from page
 *   HTML), validate against the provider API, and promote on success.
 * - Suspicious detector slugs (URL paths, sandboxes) are skipped and reported.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { db } from "../src/db/db.js";
import { selectAllCompanies, upsertCompany } from "../src/db/index.js";
import { upsertRegistry } from "../src/discovery/json-writer.js";
import { atsFetchJson, atsFetchText } from "../src/ats/http.js";
import { fetchHtmlPlaywright, closePlaywrightBrowser } from "../src/scraper/playwright.js";
import { ProviderSchema, ParsingStrategySchema, type RegistryEntry } from "../src/schemas.js";
import type { Company } from "../src/types.js";

const AuditRowSchema = z.object({
  name: z.string(),
  slug: z.string(),
  strategy: z.string(),
  careersUrl: z.string(),
  bucket: z.enum(["promotable", "already-covered", "needs-tokens", "detect-failed", "no-ats", "fetch-failed"]),
  detectedProvider: z.string().nullable(),
  detectedSlug: z.string().nullable(),
  detectedUrl: z.string().nullable(),
  total: z.number().nullable(),
  detail: z.string().nullable(),
});
type AuditRow = z.infer<typeof AuditRowSchema>;

// Detector grabs of URL paths / sandbox tenants — never real boards.
const SUSPECT_SLUGS = new Set(["recruiting-software", "my-applications", "embed", "hp-sandbox"]);

const denyStmt = db.prepare(
  "UPDATE companies SET status = 'denied', deny_reason = :reason WHERE provider = :provider AND slug = :slug",
);

function findDbCompany(all: Company[], row: AuditRow): Company | null {
  return all.find((c) => c.slug === row.slug && c.parsingStrategy === row.strategy && c.name === row.name)
      ?? all.find((c) => c.slug === row.slug && c.parsingStrategy === row.strategy)
      ?? null;
}

interface Promotion {
  entry: RegistryEntry;
  fromRows: AuditRow[];
  jobs: number | null;
}

function buildPromotions(rows: AuditRow[], stamp: string, all: Company[]): { promotions: Promotion[]; skipped: string[] } {
  const skipped: string[] = [];
  const byBoard = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (!r.detectedProvider || !r.detectedSlug) continue;
    if (SUSPECT_SLUGS.has(r.detectedSlug)) {
      skipped.push(`${r.name}: suspect slug ${r.detectedProvider}/${r.detectedSlug}`);
      continue;
    }
    // Idempotency: a board already in the DB (e.g. from a previous --apply)
    // needs no new entry, and its source rows need no retirement re-run.
    if (all.some((c) => c.provider === r.detectedProvider && c.slug === r.detectedSlug)) {
      skipped.push(`${r.name}: ${r.detectedProvider}/${r.detectedSlug} already in DB`);
      continue;
    }
    const key = `${r.detectedProvider}/${r.detectedSlug}`;
    byBoard.set(key, [...(byBoard.get(key) ?? []), r]);
  }

  const promotions: Promotion[] = [];
  for (const group of byBoard.values()) {
    const primary = [...group].sort((a, b) => a.name.length - b.name.length)[0];
    if (!primary?.detectedProvider || !primary.detectedSlug) continue;
    const sourceParse = ProviderSchema.safeParse(primary.detectedProvider);
    if (!sourceParse.success) {
      skipped.push(`${primary.name}: provider ${primary.detectedProvider} not in registry schema`);
      continue;
    }
    const entry: RegistryEntry = {
      name: primary.name,
      careers_url: primary.careersUrl,
      source: sourceParse.data,
      source_slug: primary.detectedSlug,
      parsing_strategy: "ats-api",
      status: "candidate",
      discovered_via: "ats-audit",
      discovered_at: stamp,
      evidence: `ats-audit ${stamp}: promoted from ${primary.strategy}`,
    };
    if (primary.detectedProvider === "darwinbox" || primary.detectedProvider === "workday") {
      if (primary.detectedUrl) entry.tenant_url = primary.detectedUrl;
    }
    if (primary.detectedProvider === "keka") {
      const guid = primary.detail?.match(/orgGuid=([0-9a-f-]+)/i)?.[1];
      if (!guid) { skipped.push(`${primary.name}: keka row missing orgGuid detail`); continue; }
      entry.api_meta = { orgGuid: guid };
    }
    promotions.push({ entry, fromRows: group, jobs: primary.total });
  }
  return { promotions, skipped };
}

/* ===== phase 3: token extraction for eightfold / oracle ===== */

const SITE_RE = /\/sites\/(CX_[0-9]+)/i;
const EF_DOMAIN_RES = [/[?&]domain=([a-z0-9._-]+)/i, /"domain"\s*:\s*"([a-z0-9._-]+)"/i];

// SPA careers pages hide tokens from a raw GET — render as a fallback.
async function pageTextRawThenRendered(url: string, provider: string): Promise<string[]> {
  const texts: string[] = [];
  try { texts.push(await atsFetchText(url, { provider })); } catch { /* unreachable raw */ }
  try {
    const page = await fetchHtmlPlaywright(url);
    texts.push(page.html, page.finalUrl);
  } catch { /* unreachable rendered */ }
  return texts;
}

async function tryOracleTokens(row: AuditRow): Promise<RegistryEntry | null> {
  if (!row.detectedUrl) return null;
  const base = new URL(row.detectedUrl).origin;
  let site = row.careersUrl.match(SITE_RE)?.[1] ?? row.detectedUrl.match(SITE_RE)?.[1] ?? null;
  if (!site) {
    for (const text of await pageTextRawThenRendered(row.careersUrl, "oracle")) {
      site = text.match(SITE_RE)?.[1] ?? site;
      if (site) break;
    }
  }
  if (!site) return null;
  try {
    const probeUrl = `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&finder=findReqs;siteNumber=${encodeURIComponent(site)}&limit=1&offset=0`;
    const raw = await atsFetchJson(probeUrl, { provider: "oracle" });
    const ok = z.object({ items: z.array(z.unknown()) }).safeParse(raw).success;
    if (!ok) return null;
  } catch { return null; }
  return {
    name: row.name, careers_url: row.careersUrl, source: "oracle",
    source_slug: row.detectedSlug ?? row.slug, parsing_strategy: "ats-api", status: "candidate",
    discovered_via: "ats-audit", evidence: `ats-audit: oracle tokens auto-extracted (${site})`,
    tenant_url: base, api_meta: { siteNumber: site },
  };
}

async function tryEightfoldTokens(row: AuditRow): Promise<RegistryEntry | null> {
  if (!row.detectedUrl || !row.detectedSlug) return null;
  const host = new URL(row.detectedUrl).host;
  let domain: string | null = null;
  for (const url of [row.detectedUrl, row.careersUrl]) {
    if (domain) break;
    for (const text of await pageTextRawThenRendered(url, "eightfold")) {
      for (const re of EF_DOMAIN_RES) {
        domain = text.match(re)?.[1] ?? domain;
        if (domain) break;
      }
      if (domain) break;
    }
  }
  if (!domain) return null;
  try {
    const raw = await atsFetchJson(
      `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=0&num=1`,
      { provider: "eightfold" },
    );
    const ok = z.object({ positions: z.array(z.unknown()) }).safeParse(raw).success;
    if (!ok) return null;
  } catch { return null; }
  return {
    name: row.name, careers_url: row.careersUrl, source: "eightfold",
    source_slug: row.detectedSlug, parsing_strategy: "ats-api", status: "candidate",
    discovered_via: "ats-audit", evidence: `ats-audit: eightfold domain auto-extracted (${domain})`,
    tenant_url: `https://${host}`, api_meta: { domain },
  };
}

/* ===== main ===== */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: ats-promote.ts <audit.json> [--apply]"); process.exit(1); }

  const rows = AuditRowSchema.array().parse(JSON.parse(readFileSync(resolve(process.cwd(), file), "utf-8")));
  const stamp = new Date().toISOString().slice(0, 10);
  const all = selectAllCompanies();

  const { promotions, skipped } = buildPromotions(rows.filter((r) => r.bucket === "promotable"), stamp, all);

  // Phase 3: attempt tokens for eightfold/oracle needs-tokens rows.
  const tokenRows = rows.filter((r) => r.bucket === "needs-tokens" &&
    (r.detectedProvider === "oracle" || r.detectedProvider === "eightfold") &&
    !SUSPECT_SLUGS.has(r.detectedSlug ?? ""));
  const tokenFailed: string[] = [];
  for (const r of tokenRows) {
    const dup = promotions.some((p) => p.entry.source === r.detectedProvider && p.entry.source_slug === r.detectedSlug);
    const inDb = all.some((c) => c.provider === r.detectedProvider && c.slug === r.detectedSlug);
    if (dup || inDb) { tokenFailed.push(`${r.name}: board already promoted/in DB`); continue; }
    const entry = r.detectedProvider === "oracle" ? await tryOracleTokens(r) : await tryEightfoldTokens(r);
    if (entry) promotions.push({ entry, fromRows: [r], jobs: null });
    else tokenFailed.push(`${r.name}: ${r.detectedProvider}/${r.detectedSlug} token extraction/validation failed`);
  }

  // Retirements: every source row of every promotion + already-covered rows.
  const retirements: Array<{ company: Company; reason: string }> = [];
  for (const p of promotions) {
    for (const row of p.fromRows) {
      const c = findDbCompany(all, row);
      if (c && c.status !== "denied") retirements.push({ company: c, reason: `superseded: fetched via ${p.entry.source}/${p.entry.source_slug} (ats-audit ${stamp})` });
    }
  }
  for (const row of rows.filter((r) => r.bucket === "already-covered")) {
    const c = findDbCompany(all, row);
    if (c && c.status !== "denied") retirements.push({ company: c, reason: `superseded: duplicate of ${row.detectedProvider}/${row.detectedSlug} (ats-audit ${stamp})` });
  }

  console.log(`\n=== plan (${apply ? "APPLY" : "dry run"}) ===`);
  console.log(`\nnew ats-api entries (${promotions.length}):`);
  for (const p of promotions) {
    const meta = p.entry.api_meta ? ` api_meta=${JSON.stringify(p.entry.api_meta)}` : "";
    console.log(`  + ${p.entry.source}/${p.entry.source_slug}  "${p.entry.name}"${p.jobs !== null ? ` (${p.jobs} jobs)` : ""}${meta}`);
  }
  console.log(`\nretired scrape entries (${retirements.length}):`);
  for (const r of retirements) console.log(`  - ${r.company.provider}/${r.company.slug}  "${r.company.name}"`);
  console.log(`\nskipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  ! ${s}`);
  console.log(`\ntoken extraction failed (${tokenFailed.length}):`);
  for (const s of tokenFailed) console.log(`  ! ${s}`);

  if (!apply) { console.log("\ndry run — re-run with --apply to write registry + DB."); return; }

  const retiredEntries: RegistryEntry[] = retirements.map((r) => ({
    name: r.company.name,
    careers_url: r.company.careersUrl,
    source: ProviderSchema.parse(r.company.provider),
    source_slug: r.company.slug,
    parsing_strategy: ParsingStrategySchema.parse(r.company.parsingStrategy),
    status: "denied",
    reason: r.reason,
  }));
  const res = upsertRegistry([...promotions.map((p) => p.entry), ...retiredEntries]);
  console.log(`\nregistry updated: ${res.added} added, ${res.replaced} replaced -> ${res.path}`);

  for (const r of retirements) {
    denyStmt.run({ provider: r.company.provider, slug: r.company.slug, reason: r.reason });
  }
  for (const p of promotions) {
    upsertCompany({
      provider: ProviderSchema.parse(p.entry.source),
      slug: p.entry.source_slug ?? p.entry.name,
      name: p.entry.name,
      careersUrl: p.entry.careers_url,
      parsingStrategy: "ats-api",
      status: "candidate",
      denyReason: null,
      discoveredVia: "ats-audit",
      tenantUrl: p.entry.tenant_url ?? null,
      apiMeta: p.entry.api_meta ? JSON.stringify(p.entry.api_meta) : null,
      discoveredAt: new Date().toISOString(),
    });
  }
  console.log(`db updated: ${retirements.length} retired, ${promotions.length} promoted.`);
}

main()
  .then(() => closePlaywrightBrowser())
  .catch((err) => { console.error("promote failed:", err); process.exit(1); });
