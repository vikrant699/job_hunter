import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  classifyFetchError,
  createProviderThrottleState,
  defaultRetryPolicy,
  processBucket,
  runDeferredTransportPass,
} from "../scheduler.js";
import type { TransportRetryPolicy } from "../scheduler.js";
import type { RunContext } from "../index.js";
import type { AtsAdapter } from "../../ats/types.js";
import type { Provider } from "../../schemas.js";
import type { Company, NormalizedPosting } from "../../types.js";
import { upsertCompany, insertPostingIfNew, db } from "../../db/index.js";
import { sleep } from "../../util/sleep.js";
import { assertNotEdgeChallenge } from "../../util/errorCause.js";
import { logger } from "../../logger.js";

const RemovedAtRowSchema = z.object({ removed_at: z.string().nullable() });
function removedAt(provider: string, externalId: string, profileId: string): string | null {
  const row = db
    .prepare("SELECT removed_at FROM postings WHERE provider = ? AND external_id = ? AND profile_id = ?")
    .get(provider, externalId, profileId);
  return RemovedAtRowSchema.parse(row).removed_at;
}

const BoardRunRowSchema = z.object({
  status: z.string(),
  added: z.number(),
  removed: z.number(),
  unchanged: z.number(),
  error: z.string().nullable(),
});
function latestBoardRun(provider: string, slug: string): z.infer<typeof BoardRunRowSchema> {
  const row = db
    .prepare("SELECT status, added, removed, unchanged, error FROM board_runs WHERE provider = ? AND company_slug = ? ORDER BY run_at DESC LIMIT 1")
    .get(provider, slug);
  return BoardRunRowSchema.parse(row);
}

function mkPosting(provider: Provider, externalId: string, companySlug: string, companyName: string): NormalizedPosting {
  return {
    provider, externalId, companySlug, companyName,
    jobTitle: "X", jobUrl: "https://x", location: null, isRemote: false, jdText: "", postedAt: null,
  };
}

test("classifyFetchError tags the common ATS failure modes", () => {
  assert.equal(classifyFetchError("AbortError: This operation was aborted"), "timeout");
  assert.equal(classifyFetchError("Error: lever 404"), "404");
  assert.equal(classifyFetchError("Error: gohire HTTP 429: User limit exceeded"), "rate-limited");
  assert.equal(classifyFetchError("Error: workday HTTP 520: <!DOCTYPE html>"), "5xx");
  assert.equal(classifyFetchError("Error: workday list response failed schema for logitech"), "schema");
  assert.equal(classifyFetchError("TypeError: fetch failed"), "network");
  assert.equal(classifyFetchError("Error: workday tenant URL missing site segment"), "config");
  assert.equal(classifyFetchError("Error: something weird happened"), "other");
});

// Fast policy: real backoff/deferred pacing are seconds. Tests that assert pacing override deferredPaceMs with a few ms.
const FAST: TransportRetryPolicy = { retries: 1, baseDelayMs: 1, deferredPaceMs: 0 };

let seq = 0;
function mkRunContext(): RunContext {
  seq++;
  return {
    companiesScanned: 0,
    postingsSeen: 0,
    postingsNew: 0,
    postingsGreen: 0,
    postingsYellow: 0,
    postingsTitleDenied: 0,
    postingsYoeDenied: 0,
    postingsDuplicated: 0,
    jdFetchFailed: 0,
    errors: [],
    failedCompanies: [],
    transportRetried: 0,
    transportDeferred: [],
    transportRecovered: 0,
    priorNotifyKeys: new Set<string>(),
    seenNotifyKeys: new Set<string>(),
    profileId: `sched-profile-${Date.now()}-${seq}`,
    bucketProgress: new Map(),
  };
}

/** Seed a real companies row so the mark* statements have something to update. */
function seedCompany(slug: string, provider: Provider = "greenhouse"): Company {
  const company: Company = {
    provider,
    slug,
    name: `Test ${slug}`,
    careersUrl: `https://boards.greenhouse.io/${slug}`,
    parsingStrategy: "ats-api",
    status: "active",
    denyReason: null,
    discoveredVia: null,
    tenantUrl: null,
    apiMeta: null,
    discoveredAt: new Date().toISOString(),
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    postingsSeenTotal: 0,
    postingsMatchedTotal: 0,
    zeroYieldStreak: 0,
    urlSuspect: false,
  };
  upsertCompany({
    provider: company.provider,
    slug: company.slug,
    name: company.name,
    careersUrl: company.careersUrl,
    parsingStrategy: company.parsingStrategy,
    status: company.status,
    denyReason: null,
    discoveredVia: "test",
    tenantUrl: null,
    apiMeta: null,
    discoveredAt: company.discoveredAt,
  });
  return company;
}

function failingAdapter(err: () => Error): AtsAdapter {
  return {
    provider: "greenhouse",
    listPostings: (): Promise<NormalizedPosting[]> => Promise.reject(err()),
  };
}

function dnsError(): Error {
  const cause = new Error("getaddrinfo ENOTFOUND boards.greenhouse.io");
  Object.assign(cause, { code: "ENOTFOUND" });
  return new TypeError("fetch failed", { cause });
}

function failureRow(slug: string): { consecutive_failures: number; status: string } {
  const row = db
    .prepare(
      "SELECT consecutive_failures, status FROM companies WHERE provider = 'greenhouse' AND slug = ?",
    )
    .get(slug);
  assert.ok(row && typeof row === "object", `no row for ${slug}`);
  const cf = "consecutive_failures" in row ? row.consecutive_failures : null;
  const st = "status" in row ? row.status : null;
  assert.equal(typeof cf, "number");
  assert.equal(typeof st, "string");
  return { consecutive_failures: Number(cf), status: String(st) };
}

test("a transport fault does NOT count against the board and is deferred", async () => {
  const slug = `transient-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket("greenhouse", failingAdapter(dnsError), [company], stats, FAST);

  // The board never answered, so it must not be moved toward the cf>=5 quarantine.
  assert.equal(failureRow(slug).consecutive_failures, 0, "transport fault must not increment cf");
  assert.equal(failureRow(slug).status, "active");
  // Nor counted as an error/issue yet - it gets a second chance.
  assert.equal(stats.failedCompanies.length, 0);
  assert.equal(stats.errors.length, 0);
  assert.equal(stats.transportDeferred.length, 1);
  assert.ok(stats.transportRetried > 0, "should have retried before deferring");
  // The stored diagnostics must name the real cause, not "fetch failed".
  assert.match(stats.transportDeferred[0]?.err ?? "", /ENOTFOUND/);
});

test("a board-shaped failure still counts against the board", async () => {
  const slug = `broken-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket(
    "greenhouse",
    failingAdapter(() => new Error("greenhouse 404")),
    [company],
    stats,
    FAST,
  );

  assert.equal(failureRow(slug).consecutive_failures, 1, "404 came FROM the board — it counts");
  assert.equal(stats.failedCompanies.length, 1);
  assert.equal(stats.failedCompanies[0]?.reason, "404");
  assert.equal(stats.transportDeferred.length, 0, "board errors are not retried");
  assert.equal(stats.transportRetried, 0);
});

/** What undici's res.json() throws when a JSON endpoint answers with an HTML challenge/error page instead. */
function edgeInterstitialError(): Error {
  return new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
}

test("an HTML-for-JSON edge interstitial does NOT count against the board", async () => {
  const slug = `throttled-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket("greenhouse", failingAdapter(edgeInterstitialError), [company], stats, FAST);

  // The edge answered, not the board — so this says nothing about board health.
  assert.equal(failureRow(slug).consecutive_failures, 0, "an edge page is not a board defect");
  assert.equal(failureRow(slug).status, "active");
  assert.equal(stats.failedCompanies.length, 0);
  assert.equal(stats.errors.length, 0);
  assert.equal(stats.transportDeferred.length, 1, "must get a second chance");
  assert.ok(stats.transportRetried > 0, "should have backed off and retried in place");
});

test("the deferred pass recovers a board that was only being throttled", async () => {
  const slug = `unthrottled-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  let attempts = 0;
  const throttled: AtsAdapter = {
    provider: "greenhouse",
    listPostings: (): Promise<NormalizedPosting[]> => {
      attempts++;
      // Interstitial for the whole first pass (1 try + 1 retry), then the edge relents once the burst is over.
      if (attempts <= 2) return Promise.reject(edgeInterstitialError());
      return Promise.resolve([]);
    },
  };

  await processBucket("greenhouse", throttled, [company], stats, FAST);
  assert.equal(stats.transportDeferred.length, 1, "deferred after the first pass");

  await runDeferredTransportPass(stats, FAST);

  assert.equal(stats.transportRecovered, 1);
  assert.equal(stats.failedCompanies.length, 0);
  assert.equal(failureRow(slug).consecutive_failures, 0);
  assert.equal(failureRow(slug).status, "active");
});

test("a genuinely malformed JSON body still counts against the board", async () => {
  const slug = `malformed-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket(
    "greenhouse",
    // No opening tag: the board's own application returned garbage.
    failingAdapter(() => new SyntaxError(`Unexpected token 'x', "xnot json" is not valid JSON`)),
    [company],
    stats,
    FAST,
  );

  assert.equal(failureRow(slug).consecutive_failures, 1);
  assert.equal(stats.failedCompanies.length, 1);
  assert.equal(stats.transportDeferred.length, 0);
  assert.equal(stats.transportRetried, 0, "board defects are not retried");
});

/**
 * What an HTML adapter's dead-tenant guard throws once it notices the body is a
 * bot-block page rather than a board. Built through the real guard so the test
 * pins the routing, not a hand-copied message.
 */
function challengePageError(): Error {
  const body =
    `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>` +
    `<body><h1>Sorry, you have been blocked</h1></body></html>`;
  try {
    assertNotEdgeChallenge("radancy", "https://careers.astrazeneca.com/search-jobs", body);
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error("assertNotEdgeChallenge failed to reject a Cloudflare block page");
}

test("a WAF challenge page does NOT count against the board and is deferred", async () => {
  const slug = `challenged-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket("greenhouse", failingAdapter(challengePageError), [company], stats, FAST);

  // An edge refused us, so the board's application never spoke - WAF-fronted boards must not walk toward the cf>=5 quarantine.
  assert.equal(failureRow(slug).consecutive_failures, 0, "a block page is not a board defect");
  assert.equal(failureRow(slug).status, "active");
  assert.equal(stats.failedCompanies.length, 0);
  assert.equal(stats.errors.length, 0);
  assert.equal(stats.transportDeferred.length, 1, "must get a second chance");
  assert.ok(stats.transportRetried > 0, "should have backed off and retried in place");
});

test("a genuinely dead board still counts against it — this is no blanket amnesty", async () => {
  const slug = `dead-board-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket(
    "greenhouse",
    // radancy's verdict for a host that stopped serving the board: no job cards and
    // no pager state, and nothing about the body says an edge intervened.
    failingAdapter(
      () =>
        new Error(
          `radancy: board no longer served — https://careers.ford.com/search-jobs returned a ` +
            `page with no job cards AND no data-total-results pager state, so it is not a ` +
            `Radancy search-results page and the board is dead rather than empty.`,
        ),
    ),
    [company],
    stats,
    FAST,
  );

  assert.equal(failureRow(slug).consecutive_failures, 1, "a dead board must reach quarantine");
  assert.equal(stats.failedCompanies.length, 1);
  assert.equal(stats.transportDeferred.length, 0, "board defects are not deferred");
  assert.equal(stats.transportRetried, 0, "board defects are not retried");
});

test("the deferred pass recovers a board whose network came back", async () => {
  const slug = `recovers-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  let attempts = 0;
  const flaky: AtsAdapter = {
    provider: "greenhouse",
    listPostings: (): Promise<NormalizedPosting[]> => {
      attempts++;
      // Fail every attempt of the first pass (1 try + 1 retry), then succeed.
      if (attempts <= 2) return Promise.reject(dnsError());
      return Promise.resolve([]);
    },
  };

  await processBucket("greenhouse", flaky, [company], stats, FAST);
  assert.equal(stats.transportDeferred.length, 1, "deferred after the first pass");

  await runDeferredTransportPass(stats, FAST);

  assert.equal(stats.transportRecovered, 1);
  assert.equal(stats.transportDeferred.length, 0);
  assert.equal(stats.failedCompanies.length, 0, "recovered board is not an issue");
  assert.equal(failureRow(slug).consecutive_failures, 0);
  assert.equal(failureRow(slug).status, "active");
});

test("a board failing transport on BOTH passes finally becomes a real failure", async () => {
  const slug = `hopeless-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket("greenhouse", failingAdapter(dnsError), [company], stats, FAST);
  await runDeferredTransportPass(stats, FAST);

  assert.equal(stats.transportRecovered, 0);
  assert.equal(stats.transportDeferred.length, 0, "queue must be drained, not left to grow");
  assert.equal(stats.failedCompanies.length, 1);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0] ?? "", /both passes/);
  // Only now does it count toward quarantine — once, not once per attempt.
  assert.equal(failureRow(slug).consecutive_failures, 1);
});

test("runDeferredTransportPass is a no-op when nothing was deferred", async () => {
  const stats = mkRunContext();
  await runDeferredTransportPass(stats, FAST);
  assert.equal(stats.transportRecovered, 0);
  assert.equal(stats.failedCompanies.length, 0);
});

// ---- the deferred pass must not replay the burst that caused the deferral ----

interface CallLog {
  slugs: string[];
  providers: string[];
  inFlight: number;
  peakInFlight: number;
}

function mkCallLog(): CallLog {
  return { slugs: [], providers: [], inFlight: 0, peakInFlight: 0 };
}

/** Records call order and peak concurrency, so a pass that fans out is
 *  distinguishable from one that walks its queue. Several adapters can share one
 *  log, which is how the cross-provider concurrency is observed. */
function recordingAdapter(provider: Provider, log: CallLog): AtsAdapter {
  return {
    provider,
    listPostings: async (c): Promise<NormalizedPosting[]> => {
      log.inFlight++;
      log.peakInFlight = Math.max(log.peakInFlight, log.inFlight);
      log.slugs.push(c.slug);
      log.providers.push(c.provider);
      // Yield: a pass that started several boards at once overlaps right here.
      await sleep(0);
      log.inFlight--;
      return [];
    },
  };
}

/** The deferred pass's whole input is this array, so pushing onto it directly
 *  keeps these tests off the first-pass retry path they don't exercise. */
function deferBoard(stats: RunContext, company: Company, adapter: AtsAdapter): void {
  stats.transportDeferred.push({ company, adapter, err: "SyntaxError: Unexpected token '<'" });
}

test("the deferred pass works boards one at a time, not at provider concurrency", async () => {
  const stats = mkRunContext();
  const log = mkCallLog();
  const adapter = recordingAdapter("greenhouse", log);
  const stamp = Date.now();
  for (let i = 0; i < 6; i++) {
    deferBoard(stats, seedCompany(`paced-${stamp}-${i}`), adapter);
  }

  await runDeferredTransportPass(stats, FAST);

  // Replaying a throttled group at concurrencyPerProvider is the same burst again, even if the boards stay unquarantined.
  assert.equal(log.peakInFlight, 1, "deferred boards must not be replayed concurrently");
  assert.equal(log.slugs.length, 6);
  assert.equal(stats.transportRecovered, 6);
  assert.equal(stats.failedCompanies.length, 0);
});

test("the deferred pass sleeps between boards, at the injected pace", async () => {
  const stats = mkRunContext();
  const log = mkCallLog();
  const adapter = recordingAdapter("greenhouse", log);
  const stamp = Date.now();
  for (let i = 0; i < 3; i++) {
    deferBoard(stats, seedCompany(`gap-${stamp}-${i}`), adapter);
  }

  const paceMs = 40;
  const started = Date.now();
  await runDeferredTransportPass(stats, { ...FAST, deferredPaceMs: paceMs });
  const elapsed = Date.now() - started;

  assert.equal(log.slugs.length, 3);
  // 3 boards leave 2 gaps; asserting only one full gap keeps the bound clear of
  // timer resolution while still failing outright if the pace is ignored.
  assert.ok(elapsed >= paceMs, `expected the pass to be paced, took ${elapsed}ms`);
  // ...and the production pace must be at least as wide as the spacing verified to work against edge throttles.
  assert.ok(defaultRetryPolicy().deferredPaceMs >= 2500);
});

test("the deferred pass interleaves providers instead of draining one vendor", async () => {
  const stats = mkRunContext();
  const log = mkCallLog();
  const stamp = Date.now();
  const greenhouse = recordingAdapter("greenhouse", log);
  const lever = recordingAdapter("lever", log);
  deferBoard(stats, seedCompany(`rr-gh-a-${stamp}`), greenhouse);
  deferBoard(stats, seedCompany(`rr-gh-b-${stamp}`), greenhouse);
  deferBoard(stats, seedCompany(`rr-lv-a-${stamp}`, "lever"), lever);
  deferBoard(stats, seedCompany(`rr-lv-b-${stamp}`, "lever"), lever);

  await runDeferredTransportPass(stats, FAST);

  // Two boards of one vendor back-to-back is the rate the pace exists to avoid,
  // so a mixed queue alternates rather than draining greenhouse first.
  assert.deepEqual(log.providers, ["greenhouse", "lever", "greenhouse", "lever"]);
  assert.equal(stats.transportRecovered, 4);
});

// ---- provider start throttle (Workday edge miscounts a burst as board failures) ----

interface StartLog {
  provider: string;
  startedAt: number;
}

/** Records each fetch's provider + start time and tracks that provider's peak concurrency, so a throttle's two
 *  guarantees (max concurrent, min spacing) are both directly observable. */
function throttleProbeAdapter(
  provider: Provider,
  delayMs: number,
  starts: StartLog[],
  inFlightByProvider: Map<string, number>,
  peakByProvider: Map<string, number>,
): AtsAdapter {
  return {
    provider,
    listPostings: async (): Promise<NormalizedPosting[]> => {
      const now = (inFlightByProvider.get(provider) ?? 0) + 1;
      inFlightByProvider.set(provider, now);
      peakByProvider.set(provider, Math.max(peakByProvider.get(provider) ?? 0, now));
      starts.push({ provider, startedAt: Date.now() });
      await sleep(delayMs);
      inFlightByProvider.set(provider, (inFlightByProvider.get(provider) ?? 1) - 1);
      return [];
    },
  };
}

test("provider throttle caps concurrency and spaces starts, leaving other providers unaffected", async () => {
  const stats = mkRunContext();
  const stamp = Date.now();
  const starts: StartLog[] = [];
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();

  const minSpacingMs = 30;
  const throttle = createProviderThrottleState({ workday: { maxConcurrent: 2, minSpacingMs } });

  const workdayCompanies = Array.from({ length: 5 }, (_, i) =>
    seedCompany(`throttle-wd-${stamp}-${i}`, "workday"),
  );
  const greenhouseCompanies = Array.from({ length: 3 }, (_, i) =>
    seedCompany(`throttle-gh-${stamp}-${i}`, "greenhouse"),
  );

  await Promise.all([
    processBucket(
      "workday",
      throttleProbeAdapter("workday", 20, starts, inFlight, peak),
      workdayCompanies,
      stats,
      FAST,
      throttle,
    ),
    processBucket(
      "greenhouse",
      throttleProbeAdapter("greenhouse", 5, starts, inFlight, peak),
      greenhouseCompanies,
      stats,
      FAST,
      throttle,
    ),
  ]);

  assert.equal(starts.filter((s) => s.provider === "workday").length, 5);
  assert.equal(starts.filter((s) => s.provider === "greenhouse").length, 3);

  // Never more than maxConcurrent workday fetches in flight at once.
  assert.ok((peak.get("workday") ?? 0) <= 2, `workday peak concurrency was ${peak.get("workday")}`);

  // Consecutive workday starts are spaced at least minSpacingMs apart.
  const workdayStarts = starts.filter((s) => s.provider === "workday").map((s) => s.startedAt);
  for (let i = 1; i < workdayStarts.length; i++) {
    const gap = (workdayStarts[i] ?? 0) - (workdayStarts[i - 1] ?? 0);
    assert.ok(gap >= minSpacingMs - 5, `workday starts ${i - 1}->${i} were only ${gap}ms apart`);
  }

  // Greenhouse has no throttle entry, so its worker pool (concurrencyPerProvider) starts it unconstrained -
  // all 3 fetches should overlap rather than being serialized like workday.
  assert.ok((peak.get("greenhouse") ?? 0) > 1, "greenhouse fetches should overlap, not be spaced");
});

test("un-throttled provider's start() is a pure passthrough", async () => {
  const throttle = createProviderThrottleState({ workday: { maxConcurrent: 2, minSpacingMs: 4000 } });
  const before = Date.now();
  const release = await throttle.start("greenhouse");
  assert.ok(Date.now() - before < 10, "un-throttled start must not wait");
  release();
});

// ---- posting lifecycle: last_seen_at / removed_at / board_runs ----

test("a listing that shrinks from 3 to 2 marks exactly the missing posting removed and records board_runs {added:0, removed:1, unchanged:2}", async () => {
  const slug = `shrink-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  const idA = `shrink-a-${Date.now()}`;
  const idB = `shrink-b-${Date.now()}`;
  const idC = `shrink-c-${Date.now()}`;
  for (const id of [idA, idB, idC]) {
    insertPostingIfNew(mkPosting("greenhouse", id, slug, company.name), stats.profileId);
  }

  // idA/idB are still listed; both already exist in the DB, so processOnePosting is a no-op for them
  // (postingExists short-circuits) — the lifecycle bookkeeping lives entirely in processOneCompany.
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [
      mkPosting("greenhouse", idA, slug, company.name),
      mkPosting("greenhouse", idB, slug, company.name),
    ],
  };

  await processBucket("greenhouse", adapter, [company], stats, FAST);

  assert.equal(removedAt("greenhouse", idA, stats.profileId), null);
  assert.equal(removedAt("greenhouse", idB, stats.profileId), null);
  assert.ok(removedAt("greenhouse", idC, stats.profileId) !== null, "the dropped posting must be marked removed");

  const run = latestBoardRun("greenhouse", slug);
  assert.equal(run.status, "ok");
  assert.equal(run.added, 0);
  assert.equal(run.removed, 1);
  assert.equal(run.unchanged, 2);
  assert.equal(run.error, null);
});

test("a board-shaped fetch failure writes an error board_runs row and leaves postings' removed_at untouched", async () => {
  const slug = `fail-lifecycle-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  const id = `fail-lifecycle-${Date.now()}`;
  insertPostingIfNew(mkPosting("greenhouse", id, slug, company.name), stats.profileId);

  await processBucket(
    "greenhouse",
    failingAdapter(() => new Error("greenhouse 404")),
    [company],
    stats,
    FAST,
  );

  assert.equal(removedAt("greenhouse", id, stats.profileId), null, "a failed fetch must never touch lifecycle columns");

  const run = latestBoardRun("greenhouse", slug);
  assert.equal(run.status, "error");
  assert.equal(run.added, 0);
  assert.equal(run.removed, 0);
  assert.equal(run.unchanged, 0);
  assert.match(run.error ?? "", /404/);
});

test("a board that never answers on either pass still gets an error board_runs row after the deferred pass gives up", async () => {
  const slug = `hopeless-lifecycle-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  await processBucket("greenhouse", failingAdapter(dnsError), [company], stats, FAST);
  await runDeferredTransportPass(stats, FAST);

  const run = latestBoardRun("greenhouse", slug);
  assert.equal(run.status, "error");
  assert.equal(run.added, 0);
  assert.equal(run.removed, 0);
  assert.equal(run.unchanged, 0);
  assert.match(run.error ?? "", /both passes/);
});

// ---- aggregator-board warning (log-only, no behavior change) ----

interface LogCall {
  level: "warn";
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- conforms to pino's LogFn signature; narrowing the parameter would break assignability
  fields: unknown;
  message: string | undefined;
}

/** Runs `fn` with the shared logger's warn swapped for a recorder, since scheduler.ts logs via the module-scoped pino instance with no injection point. */
async function captureWarnLogs(fn: () => Promise<void>): Promise<LogCall[]> {
  const calls: LogCall[] = [];
  const realWarn = logger.warn;
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- conforms to pino's LogFn signature; narrowing the parameter would break assignability
  logger.warn = (fields: unknown, message?: string) => { calls.push({ level: "warn", fields, message }); };
  try {
    await fn();
  } finally {
    logger.warn = realWarn;
  }
  return calls;
}

function aggregatorLogs(calls: LogCall[]): LogCall[] {
  return calls.filter((c) => c.message === "board looks like an aggregator");
}

test("a listing spanning >10 distinct companyNames logs exactly one 'aggregator' warn", async () => {
  const slug = `agency-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () =>
      Array.from({ length: 12 }, (_, i) => mkPosting("greenhouse", `agency-${Date.now()}-${i}`, slug, `Org ${i}`)),
  };

  const calls = await captureWarnLogs(() => processBucket("greenhouse", adapter, [company], stats, FAST));

  const hits = aggregatorLogs(calls);
  assert.equal(hits.length, 1, `expected exactly one aggregator warn, got ${JSON.stringify(calls)}`);
  const fields = z
    .object({ provider: z.string(), slug: z.string(), distinctOrgs: z.number(), sample: z.array(z.string()) })
    .parse(hits[0]?.fields);
  assert.equal(fields.provider, "greenhouse");
  assert.equal(fields.slug, slug);
  assert.equal(fields.distinctOrgs, 12);
  assert.deepEqual(fields.sample, ["Org 0", "Org 1", "Org 2"]);
});

test("a normal single-company listing does not log an aggregator warn", async () => {
  const slug = `normal-${Date.now()}`;
  const company = seedCompany(slug);
  const stats = mkRunContext();

  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [mkPosting("greenhouse", `normal-${Date.now()}`, slug, company.name)],
  };

  const calls = await captureWarnLogs(() => processBucket("greenhouse", adapter, [company], stats, FAST));

  assert.equal(aggregatorLogs(calls).length, 0);
});
