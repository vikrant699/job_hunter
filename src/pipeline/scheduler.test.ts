import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFetchError,
  processBucket,
  runDeferredTransportPass,
  type TransportRetryPolicy,
} from "./scheduler.js";
import type { RunContext } from "./index.js";
import type { AtsAdapter } from "../ats/types.js";
import type { Company, NormalizedPosting } from "../types.js";
import { upsertCompany, db } from "../db/index.js";

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

// Fast policy: real backoff is seconds, which tests must not wait for.
const FAST: TransportRetryPolicy = { retries: 1, baseDelayMs: 1 };

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
function seedCompany(slug: string): Company {
  const company: Company = {
    provider: "greenhouse",
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
  // Nor counted as an error/issue yet — it gets a second chance.
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

/**
 * What undici's res.json() throws when a JSON endpoint answers with an HTML
 * challenge/error page. Verbatim from run 31 (2026-08-01), where 17 Workday
 * boards hit in a 24-second window all failed with this and every one served
 * HTTP 200 application/json when probed individually minutes later.
 */
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
      // Interstitial for the whole first pass (1 try + 1 retry), then the edge
      // relents once the burst is over.
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
