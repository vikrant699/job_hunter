import { config } from "../config.js";
import { logger } from "../logger.js";
import { isDeniedCompany } from "../filter/denylist.js";
import type { RegistryEntry, Provider, ParsingStrategy } from "../schemas.js";
import { ProviderSchema } from "../schemas.js";
import { discoverFromUrl, validateCandidate, discoverKekaMeta, type AtsCandidate } from "./ats.js";
import { runBraveSource, type BraveCandidate } from "./sources/brave.js";
import { runRssSources, type RssCandidate } from "./sources/rss.js";
import { runYcSource, type YcCandidate } from "./sources/yc.js";
import { appendToRegistry, kebabCase, entryKey, knownEntryKeys, knownCompanyNames } from "./json-writer.js";

/**
 * Discovery orchestrator — pulls new candidate companies from YC, RSS funding
 * feeds, and Brave Search. Dedups against the registry, runs the services-
 * denylist pre-check, then probes each survivor for a known ATS. Surviving
 * candidates are appended to the working registry as `candidate` status.
 */

export type CandidateSource = "yc-india" | "inc42-funding" | "yourstory-funding" | "brave-search";

interface UnifiedCandidate {
  name: string;
  careersUrl: string;
  source: CandidateSource;
  evidence: string;
  /** Priority for the maxAdditionsPerRun cap: higher = kept first. */
  priority: number;
}

export interface DiscoveryAddition extends RegistryEntry {
  source: Provider;
  /** Why this got added (yc-india / inc42-funding / etc.) */
  discovered_via: CandidateSource;
}

export interface DiscoverySkip {
  name: string;
  careersUrl: string;
  source: CandidateSource;
  reason: string;
}

export interface DiscoveryResult {
  additions: DiscoveryAddition[];
  skipped: DiscoverySkip[];
  bySource: Record<CandidateSource, { surfaced: number; added: number; skipped: number }>;
  braveQuotaUsed: number;
  braveQuotaCap: number;
  errors: string[];
}

function priorityFor(source: CandidateSource): number {
  switch (source) {
    case "yc-india": return 30;
    case "inc42-funding":
    case "yourstory-funding": return 20;
    case "brave-search": return 10;
  }
}

// Map our local sources to the unified shape.
function fromBrave(c: BraveCandidate): UnifiedCandidate {
  return { name: c.name, careersUrl: c.careersUrl, source: "brave-search", evidence: c.evidence, priority: priorityFor("brave-search") };
}
function fromRss(c: RssCandidate): UnifiedCandidate {
  return { name: c.name, careersUrl: c.careersUrl, source: c.source, evidence: c.evidence, priority: priorityFor(c.source) };
}
function fromYc(c: YcCandidate): UnifiedCandidate {
  return { name: c.name, careersUrl: c.careersUrl, source: "yc-india", evidence: c.evidence, priority: priorityFor("yc-india") };
}

// Prefer (validated + adapter) > (validated) > (adapter) > first.
function pickBestAts(candidates: AtsCandidate[]): AtsCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.find((c) => c.hasAdapter && c.canValidate)
      ?? candidates.find((c) => c.hasAdapter)
      ?? candidates.find((c) => c.canValidate)
      ?? candidates[0] ?? null;
}


async function resolveRegistryEntry(
  u: UnifiedCandidate,
  now: string
): Promise<{ entry: DiscoveryAddition; skipReason?: undefined } | { entry?: undefined; skipReason: string }> {
  // SPA-only careers pages return zero candidates from raw fetch — we accept
  // the guess URL and downstream marks it llm-scrape. The weekly URL repair
  // pass cleans up bad guesses.
  let detected: AtsCandidate[] = [];
  try {
    const { candidates } = await discoverFromUrl(u.careersUrl);
    detected = candidates;
  } catch (err) {
    logger.debug({ url: u.careersUrl, err: String(err).slice(0, 120) }, "discovery: initial probe failed");
  }

  const best = pickBestAts(detected);

  // If we got an ATS hit AND we have an adapter, validate the slug actually works.
  if (best && best.hasAdapter && best.canValidate) {
    const v = await validateCandidate(best);
    if (v.ok) {
      const entry: DiscoveryAddition = {
        name: u.name,
        careers_url: u.careersUrl,
        source: ProviderSchema.parse(best.provider),
        source_slug: best.slug.includes("/") ? best.slug.split("/")[0] : best.slug,
        parsing_strategy: "ats-api",
        status: "candidate",
        discovered_via: u.source,
        discovered_at: now,
        evidence: u.evidence,
      };
      if (best.provider === "workday") entry.tenant_url = best.url;
      return { entry };
    }
    return { skipReason: `ats-detected-but-validation-failed (${best.provider}/${best.slug}: ${v.error ?? "unknown"})` };
  }

  // Keka is special among the unvalidatable-adapter providers: its missing
  // api_meta token (orgGuid) sits in the careers-page HTML, so we can extract
  // it here and register a full ats-api entry right away.
  if (best?.provider === "keka") {
    const meta = await discoverKekaMeta(best);
    if (meta) {
      logger.info(
        { name: u.name, slug: best.slug, total: meta.total },
        "discovery: keka orgGuid extracted — registering ats-api",
      );
      return {
        entry: {
          name: u.name,
          careers_url: u.careersUrl,
          source: "keka",
          source_slug: best.slug,
          parsing_strategy: "ats-api",
          status: "candidate",
          discovered_via: u.source,
          discovered_at: now,
          evidence: u.evidence,
          api_meta: { orgGuid: meta.orgGuid },
        },
      };
    }
    // Extraction or embed-API validation failed — fall through to llm-scrape.
  }

  // Adapter exists but the provider has no validation probe — and these
  // providers (eightfold/oracle, plus keka when extraction fails) need
  // api_meta tokens we couldn't supply, so registering ats-api would just
  // rack up five failed fetches and flip the company to broken. Keep
  // llm-scrape, but preserve the detected provider + slug so a repair pass
  // can promote the entry to ats-api later without re-detection.
  if (best?.hasAdapter) {
    logger.info(
      { name: u.name, provider: best.provider, slug: best.slug, url: best.url },
      "discovery: adapter available but unvalidatable — registering llm-scrape (promotable to ats-api)",
    );
    return {
      entry: {
        name: u.name,
        careers_url: u.careersUrl,
        source: ProviderSchema.parse(best.provider),
        source_slug: best.slug.includes("/") ? best.slug.split("/")[0] : best.slug,
        parsing_strategy: "llm-scrape",
        status: "candidate",
        discovered_via: u.source,
        discovered_at: now,
        evidence: u.evidence,
      },
    };
  }

  // Fallback: register as custom + llm-scrape. Pipeline's SPA sentinel will
  // flag the entry for playwright-llm-scrape if cheerio can't see the page.
  const entry: DiscoveryAddition = {
    name: u.name,
    careers_url: u.careersUrl,
    source: "custom",
    parsing_strategy: "llm-scrape",
    status: "candidate",
    discovered_via: u.source,
    discovered_at: now,
    evidence: u.evidence,
  };
  return { entry };
}

function deduplicateByName(
  candidates: UnifiedCandidate[],
  knownNames: Set<string>
): { kept: UnifiedCandidate[]; dupes: DiscoverySkip[] } {
  const kept: UnifiedCandidate[] = [];
  const dupes: DiscoverySkip[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    // Name-only dedup before probing — same company can already be registered
    // under any provider; don't re-add it as custom/<slug> just because we
    // couldn't probe its ATS this run.
    const slug = kebabCase(c.name);
    if (seen.has(slug)) {
      dupes.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: "duplicate-within-batch" });
      continue;
    }
    seen.add(slug);
    if (knownNames.has(slug)) {
      dupes.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: "already-in-registry" });
      continue;
    }
    kept.push(c);
  }
  return { kept, dupes };
}

export async function runDiscovery(): Promise<DiscoveryResult> {
  const now = new Date().toISOString();
  const errors: string[] = [];
  const bySource: Record<CandidateSource, { surfaced: number; added: number; skipped: number }> = {
    "yc-india":          { surfaced: 0, added: 0, skipped: 0 },
    "inc42-funding":     { surfaced: 0, added: 0, skipped: 0 },
    "yourstory-funding": { surfaced: 0, added: 0, skipped: 0 },
    "brave-search":      { surfaced: 0, added: 0, skipped: 0 },
  };

  // Pull candidates from each source under isolated try/catch — one flaky
  // source can't poison the run.
  const allCandidates: UnifiedCandidate[] = [];
  let braveUsed = 0;
  let braveCap: number = config.discovery.brave.monthlyCap;

  try {
    const yc = await runYcSource();
    for (const c of yc.candidates) {
      allCandidates.push(fromYc(c));
      bySource["yc-india"].surfaced++;
    }
    errors.push(...yc.errors);
  } catch (err) {
    errors.push(`yc: ${String(err).slice(0, 160)}`);
  }
  try {
    const rss = await runRssSources();
    for (const c of rss.candidates) {
      allCandidates.push(fromRss(c));
      bySource[c.source].surfaced++;
    }
    errors.push(...rss.errors);
  } catch (err) {
    errors.push(`rss: ${String(err).slice(0, 160)}`);
  }
  try {
    const brave = await runBraveSource();
    for (const c of brave.candidates) {
      allCandidates.push(fromBrave(c));
      bySource["brave-search"].surfaced++;
    }
    braveUsed = brave.quotaUsedThisMonth;
    braveCap = brave.quotaCap;
    errors.push(...brave.errors);
    if (brave.haltedReason) {
      errors.push(`brave: halted (${brave.haltedReason})`);
      logger.warn({ reason: brave.haltedReason, usedThisMonth: braveUsed }, "brave: discovery halted");
    }
  } catch (err) {
    errors.push(`brave: ${String(err).slice(0, 160)}`);
  }

  // Two-pass dedup: name-only catches duplicates across sources; (provider,
  // slug) catches when a probe resolves to an already-registered board.
  const knownNames = knownCompanyNames();
  const knownKeys = knownEntryKeys();
  const { kept, dupes } = deduplicateByName(allCandidates, knownNames);
  const skipped: DiscoverySkip[] = [...dupes];
  for (const d of dupes) bySource[d.source].skipped++;

  const surviving: UnifiedCandidate[] = [];
  for (const c of kept) {
    const deny = isDeniedCompany(c.name, kebabCase(c.name));
    if (deny.denied) {
      skipped.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: `services-deny: ${deny.reason}` });
      bySource[c.source].skipped++;
      continue;
    }
    surviving.push(c);
  }

  // Sort by priority (YC > RSS > Brave) so the maxAdditions cap keeps the best.
  surviving.sort((a, b) => b.priority - a.priority);

  const additions: DiscoveryAddition[] = [];
  const cap = config.discovery.maxAdditionsPerRun;
  for (const c of surviving) {
    if (additions.length >= cap) {
      skipped.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: "rate-limited-this-run" });
      bySource[c.source].skipped++;
      continue;
    }
    const res = await resolveRegistryEntry(c, now);
    if (res.entry) {
      // Probe might have resolved to a board we already track.
      if (knownKeys.has(entryKey(res.entry))) {
        skipped.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: "already-in-registry-via-probed-slug" });
        bySource[c.source].skipped++;
        continue;
      }
      knownKeys.add(entryKey(res.entry));
      knownNames.add(kebabCase(res.entry.name));
      additions.push(res.entry);
      bySource[c.source].added++;
    } else {
      skipped.push({ name: c.name, careersUrl: c.careersUrl, source: c.source, reason: res.skipReason });
      bySource[c.source].skipped++;
    }
  }

  if (additions.length > 0) {
    try {
      const r = appendToRegistry(additions);
      logger.info(
        { written: r.written, skippedDupes: r.skippedDuplicates, path: r.path },
        "discovery: working registry updated",
      );
    } catch (err) {
      errors.push(`registry-write: ${String(err).slice(0, 160)}`);
    }
  }

  return {
    additions,
    skipped,
    bySource,
    braveQuotaUsed: braveUsed,
    braveQuotaCap: braveCap,
    errors,
  };
}
