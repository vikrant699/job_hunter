// src/pipeline/posting-pipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedResult, verdictResult, lateLocationCheck, processOnePosting } from "../posting-pipeline.js";
import type { NormalizedPosting, Company } from "../../types.js";
import type { AtsAdapter } from "../../ats/types.js";
import type { RunContext } from "../index.js";
import type { TransportRetryPolicy } from "../scheduler.js";
import { postingExists } from "../../db/index.js";
import { notifyKey } from "../../filter/dedup.js";
import { mkAdapterCompany } from "../../ats/__tests__/test-helpers.js";

function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    provider: "ralphlauren",
    externalId: "1",
    companySlug: "ralph-lauren",
    companyName: "Ralph Lauren",
    jobTitle: "Analyst, Planning Applications",
    jobUrl: "https://careers.ralphlauren.com/en_US/CareersCorporate/JobDetailCorporate?jobId=57886",
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
    ...over,
  };
}

// ---- processOnePosting orchestration fixtures ----
// Local to this file: mirrors pipeline/index.ts's RunContext defaults and
// types.ts's Company shape for the pre-LLM drop-path pins below. A counter
// keeps externalIds unique across calls within one test process, so the same
// (provider, external_id, profile_id) row is never re-inserted across runs.
let orchPostingCounter = 0;
function mkNormalizedPosting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  orchPostingCounter++;
  return {
    provider: "greenhouse",
    externalId: `orch-${Date.now()}-${orchPostingCounter}`,
    companySlug: "acme",
    companyName: "Acme Corp",
    jobTitle: "Data Analyst",
    jobUrl: "https://example.com/jobs/1",
    location: "Bengaluru, India",
    isRemote: false,
    jdText: "",
    postedAt: null,
    ...overrides,
  };
}

function mkRunContext(overrides: Partial<RunContext> = {}): RunContext {
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
    profileId: `orch-profile-${Date.now()}`,
    bucketProgress: new Map(),
    ...overrides,
  };
}

function mkCompany(overrides: Partial<Company> = {}): Company {
  return {
    provider: "greenhouse",
    slug: "acme",
    name: "Acme Corp",
    careersUrl: "https://acme.com/careers",
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
    ...overrides,
  };
}

// The real JD backoff is 5s/10s/20s, which tests must not wait for. `retries: 1`
// keeps production's shape (attempts = 1 + retries) at millisecond scale.
const FAST: TransportRetryPolicy = { retries: 1, baseDelayMs: 1, deferredPaceMs: 0 };

const orchAdapterCompany = mkAdapterCompany({
  provider: "greenhouse",
  slug: "acme",
  name: "Acme Corp",
  careersUrl: "https://acme.com/careers",
});

// An adapter may only learn the real location while fetching the JD (Avature's
// list API gives lat/lon and leaves many jobs ungeocoded). When it resolves one,
// that metadata must face the STRICT check — the text heuristic is the
// no-metadata fallback and would defer a foreign role to the LLM gate.
test("lateLocationCheck applies the strict metadata check when fetchJd resolved a location", () => {
  // "hong kong" is a listed rejectRegion, so that rule fires first.
  const listed = lateLocationCheck(posting({ location: "Tsim Sha Tsui, Kowloon, Hong Kong SAR" }));
  assert.equal(listed.accept, false);
  assert.equal(listed.reason, "geo-rejected");

  // A foreign place NOT on the reject list still fails for want of any
  // in-region signal — which is the whole point of using the strict check here.
  const unlisted = lateLocationCheck(posting({ location: "Tsim Sha Tsui, Kowloon" }));
  assert.equal(unlisted.accept, false);
  assert.equal(unlisted.reason, "out-of-region");

  const india = lateLocationCheck(posting({ location: "Bangalore, Karnataka, India" }));
  assert.equal(india.accept, true);
});

test("lateLocationCheck falls back to the text heuristic when the location is still unknown", () => {
  const r = lateLocationCheck(posting({ location: null, jdText: "Join our Bengaluru team." }));
  assert.equal(r.accept, true);
  assert.equal(r.reason, "in-region-text");
});

test("lateLocationCheck treats an empty-string location as unknown, not as a metadata reject", () => {
  const r = lateLocationCheck(posting({ location: "", jdText: "A frontend role." }));
  assert.equal(r.accept, true);
  assert.equal(r.reason, "unknown-defer");
});

test("droppedResult defaults confidence/yoe to null and always sets llmRelevant 0, notifiedAt null", () => {
  const r = droppedResult("no-jd", "no-jd");
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "no-jd",
    llmConfidence: null,
    yoeMin: null,
    yoeMax: null,
    dropStage: "no-jd",
    notifiedAt: null,
  });
});

test("droppedResult carries through confidence and yoe when provided (silent-drop shape)", () => {
  const r = droppedResult("below floor", "silent", { llmConfidence: 0.4, yoeMin: 2, yoeMax: 4 });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "below floor",
    llmConfidence: 0.4,
    yoeMin: 2,
    yoeMax: 4,
    dropStage: "silent",
    notifiedAt: null,
  });
});

test("droppedResult (hard-deal-breaker shape): confidence set, yoe null", () => {
  const r = droppedResult("visa sponsorship required", "hard-deal-breaker", { llmConfidence: 0.9 });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "visa sponsorship required",
    llmConfidence: 0.9,
    yoeMin: null,
    yoeMax: null,
    dropStage: "hard-deal-breaker",
    notifiedAt: null,
  });
});

test("verdictResult: green sets llmRelevant 1", () => {
  const r = verdictResult("green", "great fit", 0.85, { yoeMin: 3, yoeMax: 5, notifiedAt: "2026-07-06T00:00:00.000Z" });
  assert.deepEqual(r, {
    llmRelevant: 1,
    llmReason: "great fit",
    llmConfidence: 0.85,
    yoeMin: 3,
    yoeMax: 5,
    dropStage: null,
    notifiedAt: "2026-07-06T00:00:00.000Z",
  });
});

test("verdictResult: yellow sets llmRelevant 0 and defaults dropStage to null unless given", () => {
  const r = verdictResult("yellow", "borderline", 0.55, { notifiedAt: "2026-07-06T00:00:00.000Z" });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "borderline",
    llmConfidence: 0.55,
    yoeMin: null,
    yoeMax: null,
    dropStage: null,
    notifiedAt: "2026-07-06T00:00:00.000Z",
  });
});

test("verdictResult: dropStage 'yellow' final-write shape (not notified path uses dropStage explicitly)", () => {
  const r = verdictResult("yellow", "borderline", 0.55, { dropStage: "yellow", notifiedAt: null });
  assert.equal(r.dropStage, "yellow");
  assert.equal(r.notifiedAt, null);
});

test("verdictResult: duplicate shape prefixes reason and carries extract yoe", () => {
  const r = verdictResult("green", "duplicate: great fit", 0.85, { yoeMin: 3, yoeMax: 5, dropStage: "duplicate", notifiedAt: null });
  assert.deepEqual(r, {
    llmRelevant: 1,
    llmReason: "duplicate: great fit",
    llmConfidence: 0.85,
    yoeMin: 3,
    yoeMax: 5,
    dropStage: "duplicate",
    notifiedAt: null,
  });
});

// processOnePosting orchestration: pre-LLM drop paths only (location -> dedup ->
// title-deny, all ahead of fetchJd/gate/extract). Full gate/extract stubbing would
// need a DI refactor of processOnePosting, out of scope here — these three pin the
// LLM-free stages against the real test DB (test-setup.mjs points it at a throwaway
// file) using the checked-in example profile's actual location/title-deny config.

test("processOnePosting drops an out-of-region posting before any DB write", async () => {
  const outOfRegionPosting = mkNormalizedPosting({ location: "Berlin, Germany" });
  const adapter: AtsAdapter = { provider: "greenhouse", listPostings: async () => [] };
  const stats = mkRunContext();
  await processOnePosting(adapter, orchAdapterCompany, outOfRegionPosting, mkCompany(), stats, FAST);
  assert.equal(postingExists(outOfRegionPosting.provider, outOfRegionPosting.externalId, stats.profileId), false);
});

test("processOnePosting counts a prior-notified duplicate and skips the title/JD stages", async () => {
  // Title deliberately also matches a titleDenyPatterns entry, to prove cross-run
  // dedup (priorNotifyKeys) is checked BEFORE the title-deny stage: if the pipeline
  // ever reordered these, this would report a titleDenied count instead.
  const dupPosting = mkNormalizedPosting({ location: "Bengaluru, India", jobTitle: "Frontend Engineer" });
  const stats = mkRunContext();
  stats.priorNotifyKeys.add(notifyKey(dupPosting.companyName, dupPosting.jobTitle, dupPosting.location));
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => { throw new Error("must not be called"); },
  };
  await processOnePosting(adapter, orchAdapterCompany, dupPosting, mkCompany(), stats, FAST);
  assert.equal(stats.postingsDuplicated, 1);
});

test("processOnePosting title-deny drops before fetchJd", async () => {
  // First titleDenyPatterns entry in config/profile.example.ts denies backend/
  // frontend/fullstack/... "(software) engineer" titles; "Backend Engineer" matches
  // it verbatim.
  const deniedPosting = mkNormalizedPosting({ location: "Bengaluru, India", jobTitle: "Backend Engineer" });
  const stats = mkRunContext();
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => { throw new Error("must not be called"); },
  };
  await processOnePosting(adapter, orchAdapterCompany, deniedPosting, mkCompany(), stats, FAST);
  assert.equal(stats.postingsTitleDenied, 1);
});

// ---- JD-fetch retry: which errors qualify ----
// Verbatim from run 31 (2026-08-01): what res.json() throws when a JSON endpoint
// answers with an HTML challenge/error page.
const EDGE_INTERSTITIAL = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;

test("a JD lost to an edge interstitial is retried, and the posting survives", async () => {
  const p = mkNormalizedPosting({ location: "Bengaluru, India" });
  const stats = mkRunContext();
  let calls = 0;
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => {
      calls++;
      if (calls === 1) throw new SyntaxError(EDGE_INTERSTITIAL);
      // An empty JD is a legitimate adapter result, and it halts the pipeline at
      // the "no-jd" write — after insertPostingIfNew, before any LLM call.
      return "";
    },
  };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

  // The loop used to test isTransportError alone, so an edge page got zero
  // retries and the posting vanished before it was ever inserted.
  assert.equal(calls, 2, "an edge page must be retried, not dropped");
  assert.equal(stats.jdFetchFailed, 0);
  assert.equal(stats.postingsNew, 1);
  assert.equal(postingExists(p.provider, p.externalId, stats.profileId), true);
});

test("a board-shaped JD failure is not retried", async () => {
  const p = mkNormalizedPosting({ location: "Bengaluru, India" });
  const stats = mkRunContext();
  let calls = 0;
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => {
      calls++;
      throw new Error("greenhouse HTTP 404: no such job");
    },
  };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

  // The host answered, so a second identical request only wastes a round trip.
  assert.equal(calls, 1);
  assert.equal(stats.jdFetchFailed, 1);
  assert.equal(postingExists(p.provider, p.externalId, stats.profileId), false);
});

test("an edge interstitial that never clears still gives up inside the retry budget", async () => {
  const p = mkNormalizedPosting({ location: "Bengaluru, India" });
  const stats = mkRunContext();
  let calls = 0;
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => {
      calls++;
      throw new SyntaxError(EDGE_INTERSTITIAL);
    },
  };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

  // Widening WHICH errors qualify must not widen HOW MANY attempts they get:
  // thousands of postings run through here, so the budget stays 1 + retries.
  assert.equal(calls, FAST.retries + 1);
  assert.equal(stats.jdFetchFailed, 1);
  assert.equal(postingExists(p.provider, p.externalId, stats.profileId), false);
});
