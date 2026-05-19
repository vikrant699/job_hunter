import { logger } from "../logger.js";
import { selectAllCompanies, upsertCompany } from "../db/index.js";
import { upsertWorkingJson } from "./json-writer.js";
import { searchBrave, shouldSkipHost, isCareerShaped, hostMatchesName } from "./sources/brave.js";
import type { Company, RegistryEntry } from "../types.js";

// Manual URL-repair (npm run repair-urls). For every company whose last
// fetch failed with a "URL looks wrong" error, tries same-origin path
// variants AND (with quota left) a Brave Search lookup. Conservative —
// never removes entries; ones still broken stay in the registry.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const PER_CHECK_TIMEOUT_MS = 8_000;
const REPAIR_CONCURRENCY = 4;

// Ordered by frequency of occurrence in the wild.
const CANDIDATE_PATHS = [
  "/careers",
  "/careers/",
  "/jobs",
  "/jobs/",
  "/about/careers",
  "/about-us/careers",
  "/company/careers",
  "/company/jobs",
  "/careers/jobs",
  "/careers/job-openings",
  "/careers/open-positions",
  "/work-with-us",
  "/join-us",
  "/people/careers",
  "/our-careers",
];

interface ProbeResult {
  url: string;
  ok: boolean;
  status: number | null;
}

async function probeUrl(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return { url, ok: res.ok, status: res.status };
  } catch {
    return { url, ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

// Distinguishes a "fixable URL" error from "site up but bot-blocked us" —
// the latter won't change with a path swap.
function isUrlRepairable(lastError: string | null): boolean {
  if (!lastError) return false;
  const lower = lastError.toLowerCase();
  if (lower.includes("404")) return true;
  if (lower.includes("not found")) return true;
  if (lower.includes("dns") || lower.includes("getaddrinfo")) return true;
  if (lower.includes("enotfound")) return true;
  if (lower.includes("typeerror: fetch failed")) return true;
  // 403 / 401 / 5xx / timeouts: don't try path variants — same blocker hits.
  return false;
}

// Phase B: when path-variant probing fails, try Brave Search. Catches
// rebrand / domain-move cases. First working different-host hit wins.
async function findUrlViaBraveSearch(company: Company): Promise<string | null> {
  const results = await searchBrave(`"${company.name}" careers`, { count: 10 });
  if (!results || results.length === 0) return null;

  let oldHost = "";
  try { oldHost = new URL(company.careersUrl).host.replace(/^www\./, ""); } catch { /* */ }

  for (const r of results) {
    if (!r.url) continue;
    let parsed: URL;
    try { parsed = new URL(r.url); } catch { continue; }
    if (shouldSkipHost(parsed.host)) continue;
    if (!isCareerShaped(parsed)) continue;
    // Host must plausibly belong to the company — drops aggregator and
    // VC-portfolio pages that mention the name but aren't its real domain.
    if (!hostMatchesName(parsed.host, company.name)) continue;

    // Skip the known-broken host; a real fix lives on a different domain.
    if (parsed.host.replace(/^www\./, "") === oldHost) continue;

    const probe = await probeUrl(r.url);
    if (probe.ok) {
      logger.info(
        { company: company.name, oldHost, newUrl: r.url },
        "url-repair: Brave found a working URL on a different host"
      );
      return r.url;
    }
  }
  return null;
}

async function tryRepairOne(company: Company): Promise<{ company: Company; newUrl: string | null }> {
  let origin: URL;
  try {
    origin = new URL(company.careersUrl);
  } catch {
    return { company, newUrl: null };
  }
  const base = `${origin.protocol}//${origin.host}`;

  // Also try careers.<apex> and jobs.<apex> subdomains
  let apex = origin.host.replace(/^www\./, "").replace(/^careers\./, "").replace(/^jobs\./, "");

  const candidates: string[] = [];
  for (const p of CANDIDATE_PATHS) candidates.push(`${base}${p}`);
  candidates.push(`${origin.protocol}//careers.${apex}/`);
  candidates.push(`${origin.protocol}//jobs.${apex}/`);

  for (const cand of candidates) {
    if (cand === company.careersUrl) continue;
    const r = await probeUrl(cand);
    if (r.ok) return { company, newUrl: r.url };
  }
  return { company, newUrl: null };
}

export interface UrlRepairResult {
  attempted: number;
  fixed: number;
  fixedByPathVariant: number;
  fixedByBraveSearch: number;
  fixes: Array<{ name: string; oldUrl: string; newUrl: string; via: "path-variant" | "brave-search" }>;
  stillBroken: Array<{ name: string; careersUrl: string; lastError: string | null }>;
  braveQueriesUsed: number;
  errors: string[];
}

/** Cap on Brave queries per repair run. Combined with the daily quota usage,
 *  stays comfortably under the 1000/mo free cap. */
const MAX_BRAVE_REPAIR_QUERIES = 15;

export interface RepairOptions {
  /** Find fixes but don't persist — used by the CLI for the review pass. */
  dryRun?: boolean;
  /** Only attempt repair on these names (case-insensitive exact match). */
  onlyNames?: string[];
}

export async function repairBrokenUrls(opts: RepairOptions = {}): Promise<UrlRepairResult> {
  const all = selectAllCompanies();
  let targets = all.filter((c) => isUrlRepairable(c.lastError));
  if (opts.onlyNames && opts.onlyNames.length > 0) {
    const wanted = new Set(opts.onlyNames.map((n) => n.toLowerCase()));
    targets = targets.filter((c) => wanted.has(c.name.toLowerCase()));
  }

  if (targets.length === 0) {
    return {
      attempted: 0, fixed: 0, fixedByPathVariant: 0, fixedByBraveSearch: 0,
      fixes: [], stillBroken: [], braveQueriesUsed: 0, errors: [],
    };
  }

  logger.info({ count: targets.length }, "url-repair: starting");

  const results: Array<{ company: Company; newUrl: string | null }> = new Array(targets.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const idx = cursor++;
      const r = await tryRepairOne(targets[idx]!);
      results[idx] = r;
    }
  }
  await Promise.all(Array.from({ length: REPAIR_CONCURRENCY }, () => worker()));

  const fixes: UrlRepairResult["fixes"] = [];
  const stillBroken: UrlRepairResult["stillBroken"] = [];
  const newEntries: RegistryEntry[] = [];
  const errors: string[] = [];
  let fixedByPathVariant = 0;
  let fixedByBraveSearch = 0;
  let braveQueriesUsed = 0;

  // Side effects skipped under dryRun so the CLI can preview proposed fixes.
  function recordFix(company: Company, newUrl: string, via: "path-variant" | "brave-search"): void {
    fixes.push({ name: company.name, oldUrl: company.careersUrl, newUrl, via });
    if (opts.dryRun) return;
    newEntries.push({
      name: company.name,
      careers_url: newUrl,
      source: company.provider,
      source_slug: company.slug,
      parsing_strategy: company.parsingStrategy,
      status: company.status === "broken" ? "candidate" : company.status,
      tenant_url: company.tenantUrl ?? undefined,
      evidence: `URL repaired via ${via} from ${company.careersUrl}`,
    });
    try {
      upsertCompany({
        provider: company.provider,
        slug: company.slug,
        name: company.name,
        careersUrl: newUrl,
        parsingStrategy: company.parsingStrategy,
        status: company.status === "broken" ? "candidate" : company.status,
        denyReason: company.denyReason,
        discoveredVia: company.discoveredVia,
        tenantUrl: company.tenantUrl,
        discoveredAt: company.discoveredAt,
      });
    } catch (err) {
      errors.push(`db-update-on-repair (${company.name}): ${String(err).slice(0, 120)}`);
    }
  }

  // Phase A: free path-variant probing.
  for (const r of results) {
    if (r.newUrl) {
      recordFix(r.company, r.newUrl, "path-variant");
      fixedByPathVariant++;
    } else {
      stillBroken.push({ name: r.company.name, careersUrl: r.company.careersUrl, lastError: r.company.lastError });
    }
  }

  // Phase B: Brave Search (consumes quota — capped). Stable ordering by name
  // so the same companies get the budget each run.
  stillBroken.sort((a, b) => a.name.localeCompare(b.name));
  const phaseBTargets = stillBroken.slice(0, MAX_BRAVE_REPAIR_QUERIES);
  const phaseBStillBroken: UrlRepairResult["stillBroken"] = [];
  for (const broken of stillBroken) {
    if (!phaseBTargets.includes(broken)) {
      phaseBStillBroken.push(broken);
      continue;
    }
    const company = targets.find((c) => c.name === broken.name);
    if (!company) {
      phaseBStillBroken.push(broken);
      continue;
    }
    try {
      const newUrl = await findUrlViaBraveSearch(company);
      braveQueriesUsed++;
      if (newUrl) {
        recordFix(company, newUrl, "brave-search");
        fixedByBraveSearch++;
      } else {
        phaseBStillBroken.push(broken);
      }
    } catch (err) {
      errors.push(`brave-repair (${company.name}): ${String(err).slice(0, 120)}`);
      phaseBStillBroken.push(broken);
    }
  }
  // Replace stillBroken with post-Phase-B survivors
  stillBroken.length = 0;
  stillBroken.push(...phaseBStillBroken);

  // Single atomic upsert — seed entries get overridden via the working
  // overlay (working > seed in syncRegistryFromJson).
  if (newEntries.length > 0) {
    try {
      const r = upsertWorkingJson(newEntries);
      logger.info(
        { fixed: fixes.length, replaced: r.replaced, added: r.added },
        "url-repair: working registry updated",
      );
    } catch (err) {
      errors.push(`registry-write: ${String(err).slice(0, 160)}`);
    }
  }

  return {
    attempted: targets.length,
    fixed: fixes.length,
    fixedByPathVariant,
    fixedByBraveSearch,
    fixes,
    stillBroken,
    braveQueriesUsed,
    errors,
  };
}
