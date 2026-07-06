import { logger } from "../src/logger.js";
import { selectAllCompanies, upsertCompany, clearUrlSuspect } from "../src/db/index.js";
import { upsertRegistry } from "../src/discovery/json-writer.js";
import { searchBrave, shouldSkipHost, isCareerShaped, hostMatchesName } from "../src/discovery/sources/brave.js";
import { analyzeCareersPage } from "../src/scraper/page-signals.js";
import type { Company } from "../src/types.js";
import type { RegistryEntry } from "../src/schemas.js";
import { BROWSER_UA } from "../src/util/user-agent.js";
import { probeWithTimeout } from "../src/util/probe.js";

// Manual URL-repair (npm run repair-urls). For every company whose last
// fetch failed with a "URL looks wrong" error, tries same-origin path
// variants AND (with quota left) a Brave Search lookup. Conservative —
// never removes entries; ones still broken stay in the registry.

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

// Parked / for-sale domains return HTTP 200 but are dead companies.
const PARKED_RE = /hugedomains\.com|domain_profile|sedoparking|domainmarket|buydomains|godaddy\.com\/domainsearch/i;
// Dedicated careers hosts are unambiguous even when their landing page is a JS
// shell with no static signals (careers.acme.com, jobs.acme.com, acme.careers).
const CAREERS_HOST_RE = /^(careers?|jobs?|talent|recruit|work)\./i;

/**
 * A 200 is necessary but NOT sufficient — soft-404s, homepages served at
 * /careers, and /careers paths that 301 to the site root all return 200. Accept
 * only when the landing page is plausibly a careers page (reusing the scraper's
 * content-signal analyzer), so a "repair" never swaps a careers URL for junk.
 */
function isCareersLanding(requestedUrl: string, finalUrl: string, html: string): boolean {
  let host = "";
  try { host = new URL(finalUrl).host.replace(/^www\./, ""); } catch { return false; }
  if (CAREERS_HOST_RE.test(host) || /\.careers$/i.test(host)) return true;
  const sig = analyzeCareersPage(html, finalUrl, requestedUrl);
  if (sig.redirectedToRoot) return false; // /careers -> / : the page moved/died
  return sig.looksLikeCareersPage;
}

async function probeUrl(url: string): Promise<ProbeResult> {
  const res = await probeWithTimeout(url, {
    timeoutMs: PER_CHECK_TIMEOUT_MS,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  // A status of 0 means the request itself failed (network/timeout/abort).
  if (res.status === 0) return { url, ok: false, status: null };
  // res.finalUrl is the post-redirect URL — record where we actually landed,
  // not the candidate we guessed, so repairs persist the real destination.
  const finalUrl = res.finalUrl;
  if (!res.ok) return { url: finalUrl, ok: false, status: res.status };
  if (PARKED_RE.test(finalUrl)) return { url: finalUrl, ok: false, status: res.status };
  if (!isCareersLanding(url, finalUrl, res.body)) return { url: finalUrl, ok: false, status: res.status };
  return { url: finalUrl, ok: true, status: res.status };
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
// `queried` reports whether a Brave API call was actually spent — searchBrave
// returns null without spending quota when the key is missing or the cap is hit.
async function findUrlViaBraveSearch(company: Company): Promise<{ url: string | null; queried: boolean }> {
  const results = await searchBrave(`"${company.name}" careers`, { count: 10 });
  if (!results) return { url: null, queried: false };
  if (results.length === 0) return { url: null, queried: true };

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
        { company: company.name, oldHost, newUrl: probe.url },
        "url-repair: Brave found a working URL on a different host"
      );
      return { url: probe.url, queried: true };
    }
  }
  return { url: null, queried: true };
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
  // Two ways in: an URL-shaped fetch error (404/DNS), or a page that fetched
  // fine but was flagged url_suspect (homepage at a careers path, no careers
  // signals) by the scraper's zero-yield triage.
  let targets = all.filter((c) => isUrlRepairable(c.lastError) || c.urlSuspect);
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

  const resultMap = new Map<number, { company: Company; newUrl: string | null }>();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const idx = cursor++;
      const r = await tryRepairOne(targets[idx]!);
      resultMap.set(idx, r);
    }
  }
  await Promise.all(Array.from({ length: REPAIR_CONCURRENCY }, () => worker()));
  const results = Array.from({ length: targets.length }, (_, i) => resultMap.get(i)!);

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
        apiMeta: company.apiMeta ? JSON.stringify(company.apiMeta) : null,
        discoveredAt: company.discoveredAt,
      });
      clearUrlSuspect(company.provider, company.slug);
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
      const found = await findUrlViaBraveSearch(company);
      if (found.queried) braveQueriesUsed++;
      if (found.url) {
        recordFix(company, found.url, "brave-search");
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
      const r = upsertRegistry(newEntries);
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
