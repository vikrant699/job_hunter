// data/convert-tier2.ts
/**
 * Convert research hits for Tier-2 adapters (phenom / darwinbox) into
 * ats-api registry entries. Validates by running each adapter's listPostings
 * against the live tenant, then retires the old custom slug.
 * Dry by default; --apply persists. Idempotent.
 *
 * Flags:
 *   --apply        persist changes (upsert, retire, sync)
 *   --limit <N>    cap the number of candidates processed (for quick dry-runs)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { upsertWorkingJson } from "../src/discovery/json-writer.js";
import { syncRegistryFromJson } from "../src/registry/companies.js";
import { phenomAdapter } from "../src/ats/phenom.js";
import { darwinboxAdapter } from "../src/ats/darwinbox.js";
import { closePlaywrightBrowser } from "../src/scraper/playwright.js";
import type { AdapterCompany, RegistryEntry } from "../src/types.js";

const TIER2 = new Set(["phenom", "darwinbox"]);

interface Res { name: string; ats: string; slug_or_url: string | null; }

// ---- load research hits ----
const results: Res[] = [];
for (const dir of ["data/research2", "data/research3"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (/^out-\d+\.json$/.test(f)) {
      try { results.push(...JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))); } catch { /* */ }
    }
  }
}

// ---- map research name -> existing custom slug ----
const db = new DatabaseSync("data/job_hunter.db");
const customs = db.prepare(
  "SELECT name, slug, careers_url FROM companies WHERE provider='custom' AND status IN ('active','candidate','dormant')",
).all() as Array<{ name: string; slug: string; careers_url: string }>;
db.close();
const byName = new Map(customs.map((c) => [c.name, c]));

function hostFromUrl(s: string): string | null {
  const m = s.match(/https?:\/\/([^/\s"]+)/i);
  return m ? m[1]! : null;
}

function kebabFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface Built { entry: RegistryEntry; oldSlug: string; }

// ---- buildPhenom ----
// slugOrUrl: a search-results page URL (or a careers page URL)
async function buildPhenom(name: string, c: { slug: string }, slugOrUrl: string): Promise<Built | null> {
  const slug = c.slug || kebabFromName(name);

  // Use the provided URL as-is for the tenant URL
  let tenantUrl = slugOrUrl;

  const company: AdapterCompany = {
    provider: "phenom",
    slug,
    name,
    careersUrl: tenantUrl,
    tenantUrl,
    apiMeta: null,
  };

  let postings = await phenomAdapter.listPostings(company).catch(() => []);

  // If zero results and URL does not contain search-results, retry with /search-results appended
  if (postings.length === 0 && !tenantUrl.includes("search-results")) {
    // Strip trailing slash and append /search-results
    const retryUrl = tenantUrl.replace(/\/$/, "") + "/search-results";
    const retryCompany: AdapterCompany = { ...company, careersUrl: retryUrl, tenantUrl: retryUrl };
    postings = await phenomAdapter.listPostings(retryCompany).catch(() => []);
    if (postings.length > 0) {
      tenantUrl = retryUrl;
    }
  }

  if (postings.length === 0) return null;

  return {
    oldSlug: c.slug,
    entry: {
      name,
      careers_url: tenantUrl,
      source: "phenom",
      source_slug: slug,
      parsing_strategy: "ats-api",
      status: "candidate",
      discovered_via: "convert-tier2",
      evidence: `phenom (${postings.length} jobs)`,
      tenant_url: tenantUrl,
    },
  };
}

// ---- buildDarwinbox ----
// slugOrUrl: e.g. https://emeritus.darwinbox.in/... or https://emeritus.darwinbox.in
async function buildDarwinbox(name: string, c: { slug: string }, slugOrUrl: string): Promise<Built | null> {
  // Derive origin from the URL (normalise any path to /ms/candidate/careers)
  let origin: string;
  try {
    const u = new URL(slugOrUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  const careersUrl = `${origin}/ms/candidate/careers`;
  // Use the company's OWN slug, NOT the darwinbox subdomain: the adapter reaches
  // the API via tenant_url, so the slug is just an identifier. Keying on the
  // subdomain collides when group companies share one tenant (Emeritus+Eruditus
  // -> emeritus; Karza -> perfios). Postings are deduped by (provider,external_id)
  // downstream, so two entries on one shared tenant are safe.
  const company: AdapterCompany = {
    provider: "darwinbox",
    slug: c.slug,
    name,
    careersUrl,
    tenantUrl: careersUrl,
    apiMeta: null,
  };

  const postings = await darwinboxAdapter.listPostings(company).catch(() => []);
  if (postings.length === 0) return null;

  return {
    oldSlug: c.slug,
    entry: {
      name,
      careers_url: careersUrl,
      source: "darwinbox",
      source_slug: c.slug,
      parsing_strategy: "ats-api",
      status: "candidate",
      discovered_via: "convert-tier2",
      evidence: `darwinbox (${postings.length} jobs)`,
      tenant_url: careersUrl,
    },
  };
}

// ---- parse --limit flag ----
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1]!, 10) : Infinity;

// ---- deduplicate candidates ----
const seen = new Set<string>();
const allCandidates = results.filter(
  (r) => TIER2.has(r.ats) && r.slug_or_url && byName.has(r.name) && !seen.has(r.name) && (seen.add(r.name) || true),
);

// Apply limit
const candidates = Number.isFinite(limit) ? allCandidates.slice(0, limit) : allCandidates;

console.error(`Tier-2 candidates: phenom=${allCandidates.filter((r) => r.ats === "phenom").length}, darwinbox=${allCandidates.filter((r) => r.ats === "darwinbox").length} (total ${allCandidates.length})`);
if (Number.isFinite(limit)) {
  console.error(`--limit ${limit}: processing ${candidates.length} of ${allCandidates.length}`);
}

// ---- worker pools ----
// Separate phenom (fast, HTTP) and darwinbox (slow, browser) candidates
const phenomCandidates = candidates.filter((r) => r.ats === "phenom");
const darwinboxCandidates = candidates.filter((r) => r.ats === "darwinbox");

const built: Built[] = [];

// Phenom: concurrency 6
{
  let cur = 0;
  async function phenomWorker(): Promise<void> {
    while (cur < phenomCandidates.length) {
      const r = phenomCandidates[cur++]!;
      const c = byName.get(r.name)!;
      let b: Built | null = null;
      try {
        b = await buildPhenom(r.name, c, r.slug_or_url!);
      } catch { /* skip */ }
      if (b) built.push(b);
      console.error(`${b ? "OK  " : "skip"} phenom     ${r.name}`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => phenomWorker()));
}

// Darwinbox: concurrency 2 (browser-heavy)
{
  let cur = 0;
  async function darwinboxWorker(): Promise<void> {
    while (cur < darwinboxCandidates.length) {
      const r = darwinboxCandidates[cur++]!;
      const c = byName.get(r.name)!;
      let b: Built | null = null;
      try {
        b = await buildDarwinbox(r.name, c, r.slug_or_url!);
      } catch { /* skip */ }
      if (b) built.push(b);
      console.error(`${b ? "OK  " : "skip"} darwinbox  ${r.name}`);
    }
  }
  await Promise.all(Array.from({ length: 2 }, () => darwinboxWorker()));
}

// Always close the shared Playwright browser so the process exits cleanly
await closePlaywrightBrowser();

console.error(`\nTier-2 candidates processed: ${candidates.length} | validated & converting: ${built.length}`);
const byP = built.reduce<Record<string, number>>((m, b) => { m[b.entry.source] = (m[b.entry.source] ?? 0) + 1; return m; }, {});
console.error("by provider:", JSON.stringify(byP));

if (process.argv.includes("--apply")) {
  const up = upsertWorkingJson(built.map((b) => b.entry));
  console.error(`working: replaced ${up.replaced}, added ${up.added}`);
  const oldSlugs = new Set(built.map((b) => b.oldSlug));
  function kebab(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  for (const path of ["config/companies.seed.json", "data/companies.json"]) {
    if (!existsSync(path)) continue;
    const arr = JSON.parse(readFileSync(path, "utf8")) as RegistryEntry[];
    const kept = arr.filter((e) => !(e.source === "custom" && oldSlugs.has(e.source_slug || kebab(e.name))));
    if (kept.length !== arr.length) { writeFileSync(path, JSON.stringify(kept, null, 2)); console.error(`${path}: -${arr.length - kept.length}`); }
  }
  const d = new DatabaseSync("data/job_hunter.db");
  const del = d.prepare("DELETE FROM companies WHERE slug=? AND provider='custom'");
  let n = 0; for (const s of oldSlugs) n += del.run(s).changes; d.close();
  console.error(`DB: -${n} custom`);
  syncRegistryFromJson();
  console.error("synced.");
} else {
  built.slice(0, 40).forEach((b) => console.error(`  ${b.entry.name.slice(0, 26).padEnd(26)} -> ${b.entry.source}/${b.entry.source_slug}`));
  console.error("DRY RUN — pass --apply.");
}
