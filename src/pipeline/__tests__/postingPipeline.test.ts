import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedResult, verdictResult, lateLocationCheck, processOnePosting } from "../postingPipeline.js";
import type { NormalizedPosting, Company } from "../../types.js";
import type { AtsAdapter } from "../../ats/types.js";
import type { RunContext } from "../index.js";
import type { TransportRetryPolicy } from "../scheduler.js";
import { postingExists, getPostingSalary, getPostingJdState } from "../../db/index.js";
import { db } from "../../db/db.js";
import { z } from "zod";
import { notifyKey } from "../../filter/dedup.js";
import { mkAdapterCompany } from "../../ats/__tests__/testHelpers.js";

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
    postingsYoeDenied: 0,
    postingsDuplicated: 0,
    jdFetchFailed: 0,
    noJdRechecked: 0,
    noJdRecovered: 0,
    gateErrorRetried: 0,
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

const FAST: TransportRetryPolicy = { retries: 1, baseDelayMs: 1, deferredPaceMs: 0 };

const orchAdapterCompany = mkAdapterCompany({
  provider: "greenhouse",
  slug: "acme",
  name: "Acme Corp",
  careersUrl: "https://acme.com/careers",
});

test("lateLocationCheck applies the strict metadata check when fetchJd resolved a location", () => {
  const listed = lateLocationCheck(posting({ location: "Tsim Sha Tsui, Kowloon, Hong Kong SAR" }));
  assert.equal(listed.accept, false);
  assert.equal(listed.reason, "geo-rejected");

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

test("processOnePosting drops an out-of-region posting before any DB write", async () => {
  const outOfRegionPosting = mkNormalizedPosting({ location: "Berlin, Germany" });
  const adapter: AtsAdapter = { provider: "greenhouse", listPostings: async () => [] };
  const stats = mkRunContext();
  await processOnePosting(adapter, orchAdapterCompany, outOfRegionPosting, mkCompany(), stats, FAST);
  assert.equal(postingExists(outOfRegionPosting.provider, outOfRegionPosting.externalId, stats.profileId), false);
});

test("processOnePosting counts a prior-notified duplicate and skips the title/JD stages", async () => {
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

// What res.json() throws when a JSON endpoint answers with an HTML challenge/error page.
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
      return "";
    },
  };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

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

  assert.equal(calls, 1);
  assert.equal(stats.jdFetchFailed, 1);
  assert.equal(postingExists(p.provider, p.externalId, stats.profileId), false);
});

test("processOnePosting stores annualized salary columns for a posting with a stated LPA range", async () => {
  const p = mkNormalizedPosting({
    location: "Bengaluru, India",
    jdText: "We need 8+ years of experience. CTC: 10-12 LPA.",
  });
  const stats = mkRunContext();
  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => { throw new Error("must not be called: jdText already set"); },
  };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

  assert.equal(stats.postingsYoeDenied, 1);
  const salary = getPostingSalary(p.provider, p.externalId, stats.profileId);
  assert.ok(salary);
  assert.equal(salary.salaryCurrency, "INR");
  assert.equal(salary.salaryPeriod, "year");
  assert.equal(salary.salaryMin, 1_000_000);
  assert.equal(salary.salaryMax, 1_200_000);
});

test("processOnePosting leaves salary columns null when the JD states no salary", async () => {
  const p = mkNormalizedPosting({
    location: "Bengaluru, India",
    jdText: "We need 8+ years of experience. No compensation details are listed.",
  });
  const stats = mkRunContext();
  const adapter: AtsAdapter = { provider: "greenhouse", listPostings: async () => [] };

  await processOnePosting(adapter, orchAdapterCompany, p, mkCompany(), stats, FAST);

  const salary = getPostingSalary(p.provider, p.externalId, stats.profileId);
  assert.ok(salary);
  assert.equal(salary.salaryMin, null);
  assert.equal(salary.salaryMax, null);
  assert.equal(salary.salaryCurrency, null);
  assert.equal(salary.salaryPeriod, null);
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

  assert.equal(calls, FAST.retries + 1);
  assert.equal(stats.jdFetchFailed, 1);
  assert.equal(postingExists(p.provider, p.externalId, stats.profileId), false);
});

const DAY_MS = 24 * 60 * 60 * 1000;
const StoredResultSchema = z.object({ drop_stage: z.string().nullable(), llm_reason: z.string().nullable(), jd_checked_at: z.string().nullable() });
function storedResult(p: NormalizedPosting, profileId: string): z.infer<typeof StoredResultSchema> {
  const row = db
    .prepare("SELECT drop_stage, llm_reason, jd_checked_at FROM postings WHERE provider = ? AND external_id = ? AND profile_id = ?")
    .get(p.provider, p.externalId, profileId);
  return StoredResultSchema.parse(row);
}
function ageRow(p: NormalizedPosting, profileId: string, days: number): void {
  db.prepare("UPDATE postings SET discovered_at = ? WHERE provider = ? AND external_id = ? AND profile_id = ?")
    .run(new Date(Date.now() - days * DAY_MS).toISOString(), p.provider, p.externalId, profileId);
}
function jdAdapter(jd: () => string): { adapter: AtsAdapter; calls: () => number } {
  let n = 0;
  return {
    adapter: { provider: "greenhouse", listPostings: async () => [], fetchJd: async () => { n++; return jd(); } },
    calls: () => n,
  };
}
async function storeAsNoJd(p: NormalizedPosting, stats: RunContext): Promise<void> {
  await processOnePosting(jdAdapter(() => "").adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "no-jd");
}

test("a no-jd posting is not re-fetched inside the recheck window", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  await storeAsNoJd(p, stats);

  const { adapter, calls } = jdAdapter(() => "We need 8+ years of experience.");
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(calls(), 0);
  assert.equal(stats.noJdRechecked, 0);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "no-jd");
});

test("a due no-jd posting whose JD is still empty is stamped and stays no-jd, and is not counted as new", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  await storeAsNoJd(p, stats);
  ageRow(p, stats.profileId, 8);

  const { adapter, calls } = jdAdapter(() => "");
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(calls(), 1);
  assert.equal(stats.postingsNew, 1, "only the first sighting counts as new");
  assert.equal(stats.noJdRechecked, 1);
  assert.equal(stats.noJdRecovered, 0);
  const row = storedResult(p, stats.profileId);
  assert.equal(row.drop_stage, "no-jd");
  assert.ok(row.jd_checked_at);

  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);
  assert.equal(calls(), 1, "the stamp restarts the 7-day window");
});

test("a due no-jd posting whose JD now exists runs the full gauntlet and overwrites the row", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  await storeAsNoJd(p, stats);
  ageRow(p, stats.profileId, 8);

  const { adapter } = jdAdapter(() => "We need 8+ years of experience. CTC: 10-12 LPA.");
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(stats.postingsNew, 1);
  assert.equal(stats.noJdRechecked, 1);
  assert.equal(stats.noJdRecovered, 1);
  assert.equal(stats.postingsYoeDenied, 1);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "yoe-deny");
  assert.equal(getPostingSalary(p.provider, p.externalId, stats.profileId)?.salaryMin, 1_000_000);
});

test("a recheck that still finds a junk JD keeps the row no-jd with the junk reason", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  await storeAsNoJd(p, stats);
  ageRow(p, stats.profileId, 8);

  await processOnePosting(jdAdapter(() => "TBD").adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(stats.noJdRecovered, 0);
  const row = storedResult(p, stats.profileId);
  assert.equal(row.drop_stage, "no-jd");
  assert.equal(row.llm_reason, "junk-jd: TBD");
});

test("a recheck whose JD fetch fails is not stamped, so the next run tries again", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  await storeAsNoJd(p, stats);
  ageRow(p, stats.profileId, 8);

  const adapter: AtsAdapter = {
    provider: "greenhouse",
    listPostings: async () => [],
    fetchJd: async () => { throw new Error("greenhouse HTTP 404: no such job"); },
  };
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(stats.jdFetchFailed, 1);
  assert.equal(stats.noJdRechecked, 0);
  assert.equal(storedResult(p, stats.profileId).jd_checked_at, null);
});

test("an old posting with a real verdict is never re-fetched", async () => {
  const p = mkNormalizedPosting({ jdText: "We need 8+ years of experience." });
  const stats = mkRunContext();
  await processOnePosting({ provider: "greenhouse", listPostings: async () => [] }, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "yoe-deny");
  ageRow(p, stats.profileId, 30);

  const { adapter, calls } = jdAdapter(() => "anything");
  await processOnePosting(adapter, orchAdapterCompany, { ...p, jdText: "" }, mkCompany(), stats, FAST);

  assert.equal(calls(), 0);
  assert.equal(stats.noJdRechecked, 0);
  assert.equal(getPostingJdState(p.provider, p.externalId, stats.profileId)?.dropStage, "yoe-deny");
});

function storeAsGateError(p: NormalizedPosting, profileId: string, ageMs: number): void {
  db.prepare(
    "INSERT INTO postings (provider, external_id, profile_id, company_slug, job_title, job_url, location, is_remote, posted_at, discovered_at, last_seen_at, drop_stage, llm_relevant, llm_reason) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'gate-error', 0, 'gate-error: timeout')",
  ).run(p.provider, p.externalId, profileId, p.companySlug, p.jobTitle, p.jobUrl, p.location, new Date(Date.now() - ageMs).toISOString(), new Date().toISOString());
}

test("a gate-error posting from an earlier run is re-fetched and re-gated, not counted as new", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  storeAsGateError(p, stats.profileId, 2 * 60 * 60 * 1000);

  const { adapter, calls } = jdAdapter(() => "We need 8+ years of experience.");
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(calls(), 1);
  assert.equal(stats.gateErrorRetried, 1);
  assert.equal(stats.postingsNew, 0);
  assert.equal(stats.noJdRechecked, 0);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "yoe-deny");
});

test("a gate-error posting is not retried inside the retry window", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  storeAsGateError(p, stats.profileId, 5 * 60 * 1000);

  const { adapter, calls } = jdAdapter(() => "We need 8+ years of experience.");
  await processOnePosting(adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(calls(), 0);
  assert.equal(stats.gateErrorRetried, 0);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "gate-error");
});

test("a gate-error retry whose JD is now empty stores no-jd", async () => {
  const p = mkNormalizedPosting();
  const stats = mkRunContext();
  storeAsGateError(p, stats.profileId, 2 * 60 * 60 * 1000);

  await processOnePosting(jdAdapter(() => "").adapter, orchAdapterCompany, { ...p }, mkCompany(), stats, FAST);

  assert.equal(stats.gateErrorRetried, 1);
  assert.equal(stats.noJdRecovered, 0);
  assert.equal(storedResult(p, stats.profileId).drop_stage, "no-jd");
});
