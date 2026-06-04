// data/convert-tier1.ts
/**
 * Convert research hits for the four Tier-1 adapters (workable/keka/eightfold/
 * oracle) into ats-api registry entries. Discovers per-adapter tokens
 * (keka orgGuid, eightfold domain, oracle siteNumber), validates by running the
 * adapter's listPostings against the live API, retires the old custom slug.
 * Dry by default; --apply persists. Idempotent.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { upsertWorkingJson } from "../src/discovery/json-writer.js";
import { syncRegistryFromJson } from "../src/registry/companies.js";
import { extractKekaOrgGuid } from "../src/ats/keka.js";
import { workableAdapter } from "../src/ats/workable.js";
import { kekaAdapter } from "../src/ats/keka.js";
import { eightfoldAdapter } from "../src/ats/eightfold.js";
import { oracleAdapter } from "../src/ats/oracle.js";
import type { AdapterCompany, RegistryEntry } from "../src/types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIER1 = new Set(["workable", "keka", "eightfold", "oracle"]);

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

async function getText(url: string): Promise<{ status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json" }, signal: ctl.signal, redirect: "follow" });
    return { status: r.status, text: await r.text() };
  } catch { return { status: 0, text: "" }; }
  finally { clearTimeout(t); }
}

function hostFromUrl(s: string): string | null {
  const m = s.match(/https?:\/\/([^/\s"]+)/i);
  return m ? m[1]! : null;
}

interface Built { entry: RegistryEntry; oldSlug: string; }

async function buildWorkable(name: string, c: { slug: string }, slugOrUrl: string): Promise<Built | null> {
  const slug = slugOrUrl.match(/workable\.com\/(?:api\/[^/]+\/accounts\/)?([a-z0-9_-]+)/i)?.[1]
    ?? slugOrUrl.match(/^([a-z0-9_-]+)$/i)?.[1];
  if (!slug) return null;
  const company: AdapterCompany = { provider: "workable", slug, name, careersUrl: `https://apply.workable.com/${slug}/`, tenantUrl: null, apiMeta: null };
  const postings = await workableAdapter.listPostings(company).catch(() => []);
  if (postings.length === 0) return null;
  return { oldSlug: c.slug, entry: {
    name, careers_url: company.careersUrl, source: "workable", source_slug: slug,
    parsing_strategy: "ats-api", status: "candidate", discovered_via: "convert-tier1",
    evidence: `workable (${postings.length} jobs)`,
  } };
}

async function buildKeka(name: string, c: { slug: string }, slugOrUrl: string): Promise<Built | null> {
  const host = hostFromUrl(slugOrUrl) ?? `${slugOrUrl}.keka.com`;
  const tenant = host.split(".")[0]!;
  const page = await getText(`https://${tenant}.keka.com/careers/`);
  const orgGuid = extractKekaOrgGuid(page.text);
  if (!orgGuid) return null;
  const company: AdapterCompany = { provider: "keka", slug: tenant, name, careersUrl: `https://${tenant}.keka.com/careers/`, tenantUrl: null, apiMeta: { orgGuid } };
  const postings = await kekaAdapter.listPostings(company).catch(() => []);
  if (postings.length === 0) return null;
  return { oldSlug: c.slug, entry: {
    name, careers_url: company.careersUrl, source: "keka", source_slug: tenant,
    parsing_strategy: "ats-api", status: "candidate", discovered_via: "convert-tier1",
    evidence: `keka (${postings.length} jobs)`, api_meta: { orgGuid },
  } };
}

async function buildEightfold(name: string, c: { slug: string; careers_url: string }, slugOrUrl: string): Promise<Built | null> {
  const host = hostFromUrl(slugOrUrl);
  if (!host || !/eightfold\.ai|\./.test(host)) return null;
  // domain candidates: company careers host minus www, and host's first label + .com
  const careersHost = hostFromUrl(c.careers_url ?? "") ?? "";
  const domains = [careersHost.replace(/^www\./, ""), `${host.split(".")[0]}.com`].filter(Boolean);
  for (const domain of domains) {
    const company: AdapterCompany = { provider: "eightfold", slug: host.split(".")[0]!, name, careersUrl: `https://${host}/careers`, tenantUrl: `https://${host}`, apiMeta: { domain } };
    const postings = await eightfoldAdapter.listPostings(company).catch(() => []);
    if (postings.length > 0) {
      return { oldSlug: c.slug, entry: {
        name, careers_url: company.careersUrl, source: "eightfold", source_slug: host.split(".")[0]!,
        parsing_strategy: "ats-api", status: "candidate", discovered_via: "convert-tier1",
        evidence: `eightfold (${postings.length} jobs)`, tenant_url: `https://${host}`, api_meta: { domain },
      } };
    }
  }
  return null;
}

async function buildOracle(name: string, c: { slug: string }, slugOrUrl: string): Promise<Built | null> {
  const host = hostFromUrl(slugOrUrl);
  if (!host || !/\.oraclecloud\.com/i.test(host)) return null;
  const base = `https://${host}`;
  for (const site of ["CX_1", "CX_2", "CX_3", "CX_4", "CX_5", "CX_6"]) {
    const company: AdapterCompany = { provider: "oracle", slug: host.split(".")[0]!, name, careersUrl: base, tenantUrl: base, apiMeta: { siteNumber: site } };
    const postings = await oracleAdapter.listPostings(company).catch(() => []);
    if (postings.length > 0) {
      return { oldSlug: c.slug, entry: {
        name, careers_url: base, source: "oracle", source_slug: host.split(".")[0]!,
        parsing_strategy: "ats-api", status: "candidate", discovered_via: "convert-tier1",
        evidence: `oracle (${postings.length} jobs, ${site})`, tenant_url: base, api_meta: { siteNumber: site },
      } };
    }
  }
  return null;
}

const seen = new Set<string>();
const candidates = results.filter((r) => TIER1.has(r.ats) && r.slug_or_url && byName.has(r.name) && !seen.has(r.name) && (seen.add(r.name) || true));

const built: Built[] = [];
let cur = 0;
async function worker(): Promise<void> {
  while (cur < candidates.length) {
    const r = candidates[cur++]!;
    const c = byName.get(r.name)!;
    let b: Built | null = null;
    try {
      if (r.ats === "workable") b = await buildWorkable(r.name, c, r.slug_or_url!);
      else if (r.ats === "keka") b = await buildKeka(r.name, c, r.slug_or_url!);
      else if (r.ats === "eightfold") b = await buildEightfold(r.name, c, r.slug_or_url!);
      else if (r.ats === "oracle") b = await buildOracle(r.name, c, r.slug_or_url!);
    } catch { /* skip */ }
    if (b) built.push(b);
    console.error(`${b ? "OK  " : "skip"} ${r.ats.padEnd(10)} ${r.name}`);
  }
}
await Promise.all(Array.from({ length: 6 }, () => worker()));

console.error(`\nTier-1 candidates: ${candidates.length} | validated & converting: ${built.length}`);
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
