// src/ats/zappyhire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeZappyhireNew,
  normalizeZappyhireLegacy,
  normalizeZappyhireMt,
  parseZappyhireDate,
  zappyhireAdapter,
} from "../zappyhire.js";
import type { NewGenJob, LegacyJobSummary, MtSource } from "../zappyhire.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";
import { stubFetch, fetchSequence, jsonResponse } from "./test-helpers.js";

const newGenCompany: AdapterCompany = {
  provider: "zappyhire", slug: "federalbank", name: "Federal Bank",
  careersUrl: "https://federalbankcareers.zappyhire.com/", tenantUrl: null,
  apiMeta: { backendHost: "fed.portal.zappyhire.com", generation: "new" },
};

const legacyCompany: AdapterCompany = {
  provider: "zappyhire", slug: "esaf", name: "ESAF Small Finance Bank",
  careersUrl: "https://esafcareers.zappyhire.com/", tenantUrl: null,
  apiMeta: { backendHost: "zappyhire-esaf-be-prod.zappyhire.com", generation: "legacy", source: "ESAF" },
};

const mtCompany: AdapterCompany = {
  provider: "zappyhire", slug: "dhan", name: "Dhan",
  careersUrl: "https://recruitcareers.zappyhire.com/en/dhan", tenantUrl: null,
  apiMeta: { backendHost: "dhan.zappyhire-multitenant-be-prod.zappyhire.com", generation: "multitenant" },
};

const mtSource: MtSource = {
  job: 34,
  title: "Product & Growth Marketing (Raise AI)",
  location: "Mumbai",
  department: "Design",
  job_type: "Full Time",
};

// ---------- pure field mapping ----------

const newJob: NewGenJob = {
  id: 3218,
  title: "Retail Assets: Housing Loan, Loan Against Property, Auto Loans,etc. (Branch Channel)",
  description: "<p>Federal Bank is excited to announce an opportunity for <strong>sales professionals</strong>.</p>",
  deployment_location: "Anywhere in India",
  job_url: "https://fedregister.zappyhire.com/start/3218/cl/la",
  job_portal_published_datetime: "13.04.2026",
};

test("normalizeZappyhireNew maps fields, uses the API's job_url, strips HTML from the JD", () => {
  const p = normalizeZappyhireNew(newGenCompany, newJob);
  assert.equal(p.provider, "zappyhire");
  assert.equal(p.externalId, "3218");
  assert.equal(p.jobTitle, newJob.title);
  assert.equal(p.jobUrl, "https://fedregister.zappyhire.com/start/3218/cl/la");
  assert.equal(p.location, "Anywhere in India");
  assert.equal(p.isRemote, true); // "Anywhere" matches REMOTE_RE
  assert.match(p.jdText, /sales professionals/);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
  assert.equal(p.postedAt, "2026-04-13T00:00:00.000Z");
});

test("normalizeZappyhireNew falls back to a slug-derived job URL when job_url is missing", () => {
  const p = normalizeZappyhireNew(newGenCompany, { ...newJob, job_url: null });
  assert.equal(p.jobUrl, "https://federalbankcareers.zappyhire.com/job-detail/3218");
});

test("normalizeZappyhireNew: null location -> isRemote false, no location string", () => {
  const p = normalizeZappyhireNew(newGenCompany, { ...newJob, deployment_location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("parseZappyhireDate: DD.MM.YYYY -> ISO midnight UTC; unparseable/missing -> null", () => {
  assert.equal(parseZappyhireDate("13.04.2026"), "2026-04-13T00:00:00.000Z");
  assert.equal(parseZappyhireDate("2026-04-13"), null);
  assert.equal(parseZappyhireDate("recently"), null);
  assert.equal(parseZappyhireDate(null), null);
  assert.equal(parseZappyhireDate(undefined), null);
});

const legacyJob: LegacyJobSummary = {
  id: 804,
  title: "Quality Assurance- MH",
  locations: "Raipur, Nagpur, Maharashtra, Chattisgarh",
};

test("normalizeZappyhireLegacy maps fields, builds the /tr/<id> job URL, leaves JD empty", () => {
  const p = normalizeZappyhireLegacy(legacyCompany, legacyJob);
  assert.equal(p.provider, "zappyhire");
  assert.equal(p.externalId, "804");
  assert.equal(p.jobTitle, "Quality Assurance- MH");
  assert.equal(p.jobUrl, "https://esafcareers.zappyhire.com/tr/804");
  assert.equal(p.location, "Raipur, Nagpur, Maharashtra, Chattisgarh");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeZappyhireLegacy prefers an explicit tenantUrl over the slug-derived host", () => {
  const c: AdapterCompany = { ...legacyCompany, tenantUrl: "https://esafcareers.zappyhire.com" };
  const p = normalizeZappyhireLegacy(c, legacyJob);
  assert.equal(p.jobUrl, "https://esafcareers.zappyhire.com/tr/804");
});

// ---------- listPostings / fetchJd: new-gen (single call, JD inline) ----------

test("zappyhireAdapter.listPostings (new-gen): one POST, maps every open_job", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        status: 1,
        errors: "",
        results: { open_jobs: [newJob, { ...newJob, id: 3219, title: "Second Job" }], registration_open_jobs_count: 0 },
      }),
    ),
  );
  const postings = await zappyhireAdapter.listPostings(newGenCompany);
  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.externalId, "3218");
  assert.equal(postings[1]?.externalId, "3219");
  assert.match(postings[0].jdText, /sales professionals/);
});

test("zappyhireAdapter.listPostings (new-gen): empty open_jobs -> []", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ status: 1, errors: "", results: { open_jobs: [] } })));
  const postings = await zappyhireAdapter.listPostings(newGenCompany);
  assert.deepEqual(postings, []);
});

test("zappyhireAdapter.listPostings (new-gen): malformed response (no results) rejects", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ status: 0, errors: "boom" })));
  await assert.rejects(zappyhireAdapter.listPostings(newGenCompany));
});

test("zappyhireAdapter.fetchJd (new-gen): returns the already-inline jdText without any network call", async (t) => {
  stubFetch(t, fetchSequence()); // any fetch call here is a bug -- fail loudly if hit
  const posting: NormalizedPosting = {
    provider: "zappyhire", externalId: "3218", companySlug: "federalbank", companyName: "Federal Bank",
    jobTitle: "x", jobUrl: "https://x", location: null, isRemote: false,
    jdText: "already populated", postedAt: null,
  };
  assert(zappyhireAdapter.fetchJd);
  const jd = await zappyhireAdapter.fetchJd(newGenCompany, posting);
  assert.equal(jd, "already populated");
});

// ---------- listPostings / fetchJd: legacy (dept -> jobs -> JD chain) ----------

test("zappyhireAdapter.listPostings (legacy): dept dashboard then per-dept jobs, deduped by id, source param honored", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      (): Response => {
        return jsonResponse({
          status: 1, errors: "",
          results: [{ id: 2, name: "Micro Banking", job_count: 2 }, { id: 11, name: "Branch Banking", job_count: 1 }],
        });
      },
      () => jsonResponse({ status: 1, errors: "", results: [legacyJob, { id: 900, title: "Teller", locations: "Kochi" }] }),
      // Second department re-lists job 804 -- must collapse to one posting.
      () => jsonResponse({ status: 1, errors: "", results: [legacyJob] }),
    ),
  );
  const postings = await zappyhireAdapter.listPostings(legacyCompany);
  const ids = postings.map((p) => p.externalId).sort();
  assert.deepEqual(ids, ["804", "900"]);
  assert.equal(postings.find((p) => p.externalId === "804")?.jdText, "");
});

test("zappyhireAdapter.listPostings (legacy): no departments -> []", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ status: 1, errors: "", results: [] })));
  const postings = await zappyhireAdapter.listPostings(legacyCompany);
  assert.deepEqual(postings, []);
});

test("zappyhireAdapter.listPostings (legacy): malformed department response rejects", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ status: 0 })));
  await assert.rejects(zappyhireAdapter.listPostings(legacyCompany));
});

test("zappyhireAdapter.listPostings (legacy): one malformed department's jobs response is skipped, others still returned", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      () => jsonResponse({ status: 1, errors: "", results: [{ id: 2, name: "A" }, { id: 11, name: "B" }] }),
      () => jsonResponse({ status: 0 }), // dept 2's jobs call: malformed
      () => jsonResponse({ status: 1, errors: "", results: [legacyJob] }), // dept 11's jobs call: fine
    ),
  );
  const postings = await zappyhireAdapter.listPostings(legacyCompany);
  assert.deepEqual(postings.map((p) => p.externalId), ["804"]);
});

test("zappyhireAdapter.fetchJd (legacy): fetches the JD-detail call and strips HTML", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        status: 1, errors: "",
        results: { id: 804, title: "Quality Assurance- MH", description: "<ul><li>Visit assigned branches</li></ul>" },
      }),
    ),
  );
  const posting = normalizeZappyhireLegacy(legacyCompany, legacyJob);
  assert(zappyhireAdapter.fetchJd);
  const jd = await zappyhireAdapter.fetchJd(legacyCompany, posting);
  assert.match(jd, /Visit assigned branches/);
  assert.doesNotMatch(jd, /<ul>|<li>/);
});

test("zappyhireAdapter.fetchJd (legacy): malformed detail response returns empty string, not a throw", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ status: 0 })));
  const posting = normalizeZappyhireLegacy(legacyCompany, legacyJob);
  assert(zappyhireAdapter.fetchJd);
  const jd = await zappyhireAdapter.fetchJd(legacyCompany, posting);
  assert.equal(jd, "");
});

// ---------- multitenant (recruitcareers.zappyhire.com) ----------

test("normalizeZappyhireMt maps fields, builds the recruitcareers apply URL, leaves JD empty", () => {
  const p = normalizeZappyhireMt(mtCompany, mtSource);
  assert.equal(p.externalId, "34");
  assert.equal(p.jobTitle, "Product & Growth Marketing (Raise AI)");
  assert.equal(p.location, "Mumbai");
  assert.equal(p.isRemote, false);
  assert.equal(p.jobUrl, "https://recruitcareers.zappyhire.com/dhan/apply?source=1&company=1&job=34");
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("zappyhireAdapter.listPostings (multitenant): reads results.hits[]._source and dedups by job id", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        status: 1, errors: "",
        results: { total: { value: 2 }, hits: [{ _source: mtSource }, { _source: { ...mtSource, job: 35, title: "SDE II" } }] },
      }),
    ),
  );
  const postings = await zappyhireAdapter.listPostings(mtCompany);
  assert.deepEqual(postings.map((p) => p.externalId), ["34", "35"]);
});

test("zappyhireAdapter.fetchJd (multitenant): fetches the careers/jobs detail and strips HTML", async (t) => {
  stubFetch(
    t,
    fetchSequence(() => jsonResponse({ status: 1, errors: "", results: { description: "<p>Own <strong>growth</strong> loops</p>" } })),
  );
  const posting = normalizeZappyhireMt(mtCompany, mtSource);
  assert(zappyhireAdapter.fetchJd);
  const jd = await zappyhireAdapter.fetchJd(mtCompany, posting);
  assert.match(jd, /Own growth loops/);
  assert.doesNotMatch(jd, /<p>|<strong>/);
});

// ---------- apiMeta validation ----------

test("listPostings throws a clear error when apiMeta.backendHost is missing", async () => {
  const c: AdapterCompany = { ...newGenCompany, apiMeta: { generation: "new" } };
  await assert.rejects(zappyhireAdapter.listPostings(c), /apiMeta\.backendHost/);
});

test("listPostings throws a clear error when apiMeta.generation is missing or invalid", async () => {
  const c: AdapterCompany = { ...newGenCompany, apiMeta: { backendHost: "fed.portal.zappyhire.com" } };
  await assert.rejects(zappyhireAdapter.listPostings(c), /apiMeta\.generation/);
});

test("listPostings (legacy) throws when apiMeta.source is missing", async () => {
  const c: AdapterCompany = { ...legacyCompany, apiMeta: { backendHost: "zappyhire-esaf-be-prod.zappyhire.com", generation: "legacy" } };
  await assert.rejects(zappyhireAdapter.listPostings(c), /apiMeta\.source/);
});
