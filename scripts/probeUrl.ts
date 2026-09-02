/**
 * Read-only job-URL diagnostic: resolves a job posting URL to (provider, slug hint, external
 * id), then reports everything the DB (and, if needed, the live board) knows about it.
 *   npm run probe-url -- <url> [--profile <name>] [--gate]
 * Never writes to the DB. `--gate` additionally spends real LLM calls to run the actual
 * relevance gate + YOE extract for the selected profile (requires that profile's resume;
 * missing resume/config prints the pre-flight error and exits non-zero).
 */
import "dotenv/config";
import { z } from "zod";
import { db, queryAll, selectAllCompanies } from "../src/db/index.js";
import { resolveJobUrl } from "../src/util/jobUrlResolver.js";
import { resolveAdapter } from "../src/ats/registry.js";
import { describeError } from "../src/util/errorCause.js";
import type { AtsAdapter } from "../src/ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "../src/types.js";

interface CliArgs {
  url: string;
  profileId: string;
  gate: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let url: string | null = null;
  let profileId = "default";
  let gate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") {
      profileId = argv[i + 1] ?? profileId;
      i++;
      continue;
    }
    if (a === "--gate") {
      gate = true;
      continue;
    }
    if (url === null && a !== undefined && !a.startsWith("--")) url = a;
  }
  if (!url) {
    throw new Error("usage: npm run probe-url -- <url> [--profile <name>] [--gate]");
  }
  return { url, profileId, gate };
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function truncate(s: string | null, n: number): string {
  if (s === null) return "(none)";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function toAdapterCompany(c: Company): AdapterCompany {
  return {
    provider: c.provider,
    slug: c.slug,
    name: c.name,
    careersUrl: c.careersUrl,
    tenantUrl: c.tenantUrl,
    apiMeta: c.apiMeta,
  };
}

/* ===== company lookup ===== */

// Hosts shared by every tenant of a multi-tenant ATS (the tenant lives in the PATH, not the
// host) — a careers_url/tenant_url substring match on one of these would "match" every company
// on that provider, so the host fallback below is skipped for them.
const SHARED_ATS_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "jobs.smartrecruiters.com",
]);

/** (provider + exact slug) when the URL resolved to one; otherwise a careers_url/tenant_url
 *  substring match on the URL's host, narrowed by provider when one is known. Skips the host
 *  fallback for a shared multi-tenant ATS host (see SHARED_ATS_HOSTS) — that would otherwise
 *  "match" every company on the provider instead of none. */
function findCompanies(provider: string | null, slugHint: string | null, rawUrl: string): Company[] {
  const all = selectAllCompanies();
  if (provider && slugHint) {
    const exact = all.filter((c) => c.provider === provider && c.slug === slugHint);
    if (exact.length > 0) return exact;
  }
  const host = safeUrl(rawUrl)?.host.toLowerCase() ?? slugHint;
  if (!host || SHARED_ATS_HOSTS.has(host)) return [];
  return all.filter(
    (c) =>
      (provider === null || c.provider === provider) &&
      (c.careersUrl.toLowerCase().includes(host) || (c.tenantUrl?.toLowerCase().includes(host) ?? false)),
  );
}

/* ===== posting lookup ===== */

const PostingRowSchema = z.object({
  provider: z.string(),
  external_id: z.string(),
  company_slug: z.string(),
  job_title: z.string().nullable(),
  job_url: z.string(),
  location: z.string().nullable(),
  is_remote: z.number(),
  posted_at: z.string().nullable(),
  discovered_at: z.string(),
  profile_id: z.string(),
  llm_relevant: z.number().nullable(),
  llm_reason: z.string().nullable(),
  llm_confidence: z.number().nullable(),
  yoe_min: z.number().nullable(),
  yoe_max: z.number().nullable(),
  drop_stage: z.string().nullable(),
  notified_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  removed_at: z.string().nullable(),
});
type PostingRow = z.infer<typeof PostingRowSchema>;

/** host + path, query/hash and trailing slash stripped — for a LIKE fallback when the exact (provider, external_id) key doesn't apply or doesn't hit. */
function normalizedForLike(rawUrl: string): string | null {
  const u = safeUrl(rawUrl);
  if (!u) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

function findPostings(
  provider: string | null,
  externalId: string | null,
  profileId: string,
  rawUrl: string,
): PostingRow[] {
  let rows: PostingRow[] = [];
  if (provider && externalId) {
    rows = queryAll(
      db.prepare(
        "SELECT * FROM postings WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId",
      ),
      PostingRowSchema,
      { provider, externalId, profileId },
    );
  }
  if (rows.length === 0) {
    const norm = normalizedForLike(rawUrl);
    if (norm) {
      rows = queryAll(
        db.prepare("SELECT * FROM postings WHERE job_url LIKE :like AND profile_id = :profileId"),
        PostingRowSchema,
        { like: `%${norm}%`, profileId },
      );
    }
  }
  return rows;
}

/* ===== board_runs ===== */

const BoardRunRowSchema = z.object({
  run_at: z.string(),
  status: z.string(),
  added: z.number(),
  removed: z.number(),
  unchanged: z.number(),
  error: z.string().nullable(),
});
type BoardRunRow = z.infer<typeof BoardRunRowSchema>;

function findBoardRuns(provider: string, companySlug: string): BoardRunRow[] {
  return queryAll(
    db.prepare(
      "SELECT run_at, status, added, removed, unchanged, error FROM board_runs " +
        "WHERE provider = :provider AND company_slug = :companySlug ORDER BY run_at DESC LIMIT 5",
    ),
    BoardRunRowSchema,
    { provider, companySlug },
  );
}

/* ===== printing ===== */

function printResolution(r: ReturnType<typeof resolveJobUrl>): void {
  console.log("RESOLUTION");
  console.log(`  provider    : ${r.provider ?? "(unresolved)"}`);
  console.log(`  slugHint    : ${r.slugHint ?? "(none)"}`);
  console.log(`  externalId  : ${r.externalId ?? "(none)"}`);
  if (r.hint) console.log(`  hint        : ${r.hint}`);
}

function printCompany(c: Company): void {
  console.log(`  name                 : ${c.name}`);
  console.log(`  provider/slug        : ${c.provider}/${c.slug}`);
  console.log(`  status               : ${c.status}`);
  console.log(`  parsing_strategy     : ${c.parsingStrategy}`);
  console.log(`  last_fetched_at      : ${c.lastFetchedAt ?? "(never)"}`);
  console.log(`  last_success_at      : ${c.lastSuccessAt ?? "(never)"}`);
  console.log(`  consecutive_failures : ${c.consecutiveFailures}`);
  console.log(`  zero_yield_streak    : ${c.zeroYieldStreak}`);
  console.log(`  last_error           : ${truncate(c.lastError, 200)}`);
}

function printPosting(p: PostingRow): void {
  console.log(`  discovered_at   : ${p.discovered_at}`);
  console.log(`  last_seen_at    : ${p.last_seen_at ?? "(never)"}`);
  console.log(`  removed_at      : ${p.removed_at ?? "(not removed)"}`);
  console.log(`  llm_relevant    : ${p.llm_relevant ?? "(null)"}`);
  console.log(`  llm_confidence  : ${p.llm_confidence ?? "(null)"}`);
  console.log(`  llm_reason      : ${truncate(p.llm_reason, 200)}`);
  console.log(`  yoe_min/max     : ${p.yoe_min ?? "?"} / ${p.yoe_max ?? "?"}`);
  console.log(`  drop_stage      : ${p.drop_stage ?? "(none — green)"}`);
  console.log(`  notified_at     : ${p.notified_at ?? "(not notified)"}`);
}

async function main(): Promise<void> {
  const { url, profileId, gate } = parseArgs(process.argv.slice(2));

  const resolution = resolveJobUrl(url);
  printResolution(resolution);

  const companies = findCompanies(resolution.provider, resolution.slugHint, url);
  console.log(`\nCOMPANY (${companies.length} match${companies.length === 1 ? "" : "es"})`);
  if (companies.length === 0) {
    console.log("  (none found — this host/provider isn't in the registry, or the slug doesn't match)");
  } else {
    for (const c of companies) {
      printCompany(c);
      console.log("");
    }
  }
  const company = companies[0] ?? null;

  const postings = findPostings(resolution.provider, resolution.externalId, profileId, url);
  console.log(`POSTING (profile "${profileId}", ${postings.length} match${postings.length === 1 ? "" : "es"})`);
  if (postings.length === 0) {
    console.log("  (no posting row for this profile)");
  } else {
    for (const p of postings) {
      printPosting(p);
      console.log("");
    }
  }

  if (company) {
    const runs = findBoardRuns(company.provider, company.slug);
    console.log(`BOARD_RUNS (${company.provider}/${company.slug}, newest ${runs.length})`);
    if (runs.length === 0) {
      console.log("  (none)");
    } else {
      for (const r of runs) {
        const errPart = r.error ? `  error: ${truncate(r.error, 200)}` : "";
        console.log(`  ${r.run_at}  ${r.status.padEnd(5)} +${r.added} -${r.removed} =${r.unchanged}${errPart}`);
      }
    }
  }

  // Live listing: needed whenever the DB has no posting row (to explain why), and always
  // needed for --gate since postings.jd_text is never persisted (see db/schema.sql).
  let liveMatch: NormalizedPosting | null = null;
  let liveAdapter: AtsAdapter | null = null;
  let liveAdapterCompany: AdapterCompany | null = null;

  if (company && (postings.length === 0 || gate)) {
    console.log(`\nLIVE LISTING (${company.provider}/${company.slug})`);
    const adapter = resolveAdapter(company);
    if (!adapter) {
      console.log(`  no adapter resolves for parsing_strategy "${company.parsingStrategy}"`);
    } else {
      const adapterCompany = toAdapterCompany(company);
      try {
        const listing = await adapter.listPostings(adapterCompany);
        console.log(`  listing size: ${listing.length}`);
        const norm = normalizedForLike(url);
        const found =
          listing.find(
            (p) =>
              (resolution.externalId !== null && p.externalId === resolution.externalId) ||
              (norm !== null && p.jobUrl.replace(/\/+$/, "").includes(norm)),
          ) ?? null;
        if (found) {
          console.log(
            `  FOUND in live listing: "${found.jobTitle}" (externalId ${found.externalId}, location ${found.location ?? "(none)"})`,
          );
          liveMatch = found;
          liveAdapter = adapter;
          liveAdapterCompany = adapterCompany;
        } else {
          console.log("  NOT found in the current live listing (removed, or the id/url no longer matches)");
        }
      } catch (err) {
        console.log(`  live fetch failed: ${describeError(err).slice(0, 300)}`);
      }
    }
  }

  if (gate) {
    console.log("\nGATE");
    if (!company) {
      console.log("  skipped: no company row resolved for this URL — cannot fetch a live posting to gate");
    } else if (!liveMatch || !liveAdapter || !liveAdapterCompany) {
      console.log("  skipped: no live posting match found above (need a live posting to fetch a JD and gate it)");
    } else {
      const posting = liveMatch;
      const adapter = liveAdapter;
      const adapterCompany = liveAdapterCompany;
      try {
        if (!posting.jdText && adapter.fetchJd) {
          posting.jdText = await adapter.fetchJd(adapterCompany, posting);
        }
        if (!posting.jdText) {
          console.log('  no JD text available (adapter returned empty) — the pipeline would store this as "no-jd"');
        } else {
          const [{ assertLlmAvailable }, { runGate }, { runExtract }, { classifyVerdict, SILENT_SCORE_FLOOR }, { profile }] =
            await Promise.all([
              import("../src/llm/client.js"),
              import("../src/llm/gate.js"),
              import("../src/llm/extract.js"),
              import("../src/filter/verdict.js"),
              import("../src/profile.js"),
            ]);
          await assertLlmAvailable();

          const gateResult = await runGate({
            jobTitle: posting.jobTitle,
            companyName: posting.companyName,
            jdText: posting.jdText,
          });
          console.log(`  matchScore          : ${gateResult.matchScore.toFixed(3)}`);
          console.log(`  dealBreakerHit      : ${gateResult.dealBreakerHit ?? "(none)"}`);
          console.log(`  dealBreakerSeverity : ${gateResult.dealBreakerSeverity ?? "(none)"}`);
          console.log(`  gate reason         : ${truncate(gateResult.reason, 300)}`);

          let extractResult: { yoeMin: number | null; yoeMax: number | null } | null = null;
          const silentFloor = profile.filters.silentFloor ?? SILENT_SCORE_FLOOR;
          if (gateResult.dealBreakerSeverity !== "hard" && gateResult.matchScore >= silentFloor) {
            extractResult = await runExtract(posting.jdText);
            console.log(`  yoeMin / yoeMax     : ${extractResult.yoeMin ?? "?"} / ${extractResult.yoeMax ?? "?"}`);
          }
          const verdict = classifyVerdict(gateResult, extractResult, posting.jobTitle);
          console.log(`  verdict             : ${verdict.severity} — ${verdict.reason}`);
        }
      } catch (err) {
        console.log(`  gate pre-flight/run failed: ${describeError(err).slice(0, 300)}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error("probe-url failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
