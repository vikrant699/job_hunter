// src/ats/zappyhire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeZappyhireNew,
  normalizeZappyhireLegacy,
  normalizeZappyhireMt,
  parseZappyhireDate,
  parseZappyhireBundle,
  extractScriptUrls,
  zappyhireAdapter,
} from "./zappyhire.js";
import type { NewGenJob, LegacyJobSummary, MtSource } from "./zappyhire.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";

const realFetch = globalThis.fetch;
function stubFetchSeq(responses: Array<() => Response>): void {
  let i = 0;
  const fetchStub: typeof fetch = async () => {
    const make = responses[i];
    i += 1;
    if (!make) throw new Error(`unexpected extra fetch call (#${i})`);
    return make();
  };
  globalThis.fetch = fetchStub;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("zappyhireAdapter.listPostings (new-gen): one POST, maps every open_job", async () => {
  stubFetchSeq([
    () =>
      jsonResponse({
        status: 1,
        errors: "",
        results: { open_jobs: [newJob, { ...newJob, id: 3219, title: "Second Job" }], registration_open_jobs_count: 0 },
      }),
  ]);
  try {
    const postings = await zappyhireAdapter.listPostings(newGenCompany);
    assert.equal(postings.length, 2);
    assert.equal(postings[0]?.externalId, "3218");
    assert.equal(postings[1]?.externalId, "3219");
    assert.match(postings[0]?.jdText ?? "", /sales professionals/);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.listPostings (new-gen): empty open_jobs -> []", async () => {
  stubFetchSeq([() => jsonResponse({ status: 1, errors: "", results: { open_jobs: [] } })]);
  try {
    const postings = await zappyhireAdapter.listPostings(newGenCompany);
    assert.deepEqual(postings, []);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.listPostings (new-gen): malformed response (no results) rejects", async () => {
  stubFetchSeq([() => jsonResponse({ status: 0, errors: "boom" })]);
  try {
    await assert.rejects(zappyhireAdapter.listPostings(newGenCompany));
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.fetchJd (new-gen): returns the already-inline jdText without any network call", async () => {
  stubFetchSeq([]); // any fetch call here is a bug -- fail loudly if hit
  try {
    const posting: NormalizedPosting = {
      provider: "zappyhire", externalId: "3218", companySlug: "federalbank", companyName: "Federal Bank",
      jobTitle: "x", jobUrl: "https://x", location: null, isRemote: false,
      jdText: "already populated", postedAt: null,
    };
    const jd = await zappyhireAdapter.fetchJd!(newGenCompany, posting);
    assert.equal(jd, "already populated");
  } finally {
    restoreFetch();
  }
});

// ---------- listPostings / fetchJd: legacy (dept -> jobs -> JD chain) ----------

test("zappyhireAdapter.listPostings (legacy): dept dashboard then per-dept jobs, deduped by id, source param honored", async () => {
  stubFetchSeq([
    (): Response => {
      return jsonResponse({
        status: 1, errors: "",
        results: [{ id: 2, name: "Micro Banking", job_count: 2 }, { id: 11, name: "Branch Banking", job_count: 1 }],
      });
    },
    () => jsonResponse({ status: 1, errors: "", results: [legacyJob, { id: 900, title: "Teller", locations: "Kochi" }] }),
    // Second department re-lists job 804 -- must collapse to one posting.
    () => jsonResponse({ status: 1, errors: "", results: [legacyJob] }),
  ]);
  try {
    const postings = await zappyhireAdapter.listPostings(legacyCompany);
    const ids = postings.map((p) => p.externalId).sort();
    assert.deepEqual(ids, ["804", "900"]);
    assert.equal(postings.find((p) => p.externalId === "804")?.jdText, "");
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.listPostings (legacy): no departments -> []", async () => {
  stubFetchSeq([() => jsonResponse({ status: 1, errors: "", results: [] })]);
  try {
    const postings = await zappyhireAdapter.listPostings(legacyCompany);
    assert.deepEqual(postings, []);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.listPostings (legacy): malformed department response rejects", async () => {
  stubFetchSeq([() => jsonResponse({ status: 0 })]);
  try {
    await assert.rejects(zappyhireAdapter.listPostings(legacyCompany));
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.listPostings (legacy): one malformed department's jobs response is skipped, others still returned", async () => {
  stubFetchSeq([
    () => jsonResponse({ status: 1, errors: "", results: [{ id: 2, name: "A" }, { id: 11, name: "B" }] }),
    () => jsonResponse({ status: 0 }), // dept 2's jobs call: malformed
    () => jsonResponse({ status: 1, errors: "", results: [legacyJob] }), // dept 11's jobs call: fine
  ]);
  try {
    const postings = await zappyhireAdapter.listPostings(legacyCompany);
    assert.deepEqual(postings.map((p) => p.externalId), ["804"]);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.fetchJd (legacy): fetches the JD-detail call and strips HTML", async () => {
  stubFetchSeq([
    () =>
      jsonResponse({
        status: 1, errors: "",
        results: { id: 804, title: "Quality Assurance- MH", description: "<ul><li>Visit assigned branches</li></ul>" },
      }),
  ]);
  try {
    const posting = normalizeZappyhireLegacy(legacyCompany, legacyJob);
    const jd = await zappyhireAdapter.fetchJd!(legacyCompany, posting);
    assert.match(jd, /Visit assigned branches/);
    assert.doesNotMatch(jd, /<ul>|<li>/);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.fetchJd (legacy): malformed detail response returns empty string, not a throw", async () => {
  stubFetchSeq([() => jsonResponse({ status: 0 })]);
  try {
    const posting = normalizeZappyhireLegacy(legacyCompany, legacyJob);
    const jd = await zappyhireAdapter.fetchJd!(legacyCompany, posting);
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
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

test("zappyhireAdapter.listPostings (multitenant): reads results.hits[]._source and dedups by job id", async () => {
  stubFetchSeq([
    () =>
      jsonResponse({
        status: 1, errors: "",
        results: { total: { value: 2 }, hits: [{ _source: mtSource }, { _source: { ...mtSource, job: 35, title: "SDE II" } }] },
      }),
  ]);
  try {
    const postings = await zappyhireAdapter.listPostings(mtCompany);
    assert.deepEqual(postings.map((p) => p.externalId), ["34", "35"]);
  } finally {
    restoreFetch();
  }
});

test("zappyhireAdapter.fetchJd (multitenant): fetches the careers/jobs detail and strips HTML", async () => {
  stubFetchSeq([
    () => jsonResponse({ status: 1, errors: "", results: { description: "<p>Own <strong>growth</strong> loops</p>" } }),
  ]);
  try {
    const posting = normalizeZappyhireMt(mtCompany, mtSource);
    const jd = await zappyhireAdapter.fetchJd!(mtCompany, posting);
    assert.match(jd, /Own growth loops/);
    assert.doesNotMatch(jd, /<p>|<strong>/);
  } finally {
    restoreFetch();
  }
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

// ---------- per-tenant bundle discovery (parseZappyhireBundle / extractScriptUrls) ----------

test("parseZappyhireBundle detects the new-gen environment object (BASE_URL)", () => {
  const bundleText = 'var Xa={production:!0,BASE_URL:"https://fed.portal.zappyhire.com/",PORTAL_URL:"https://talentconnect.zappyhire.com/"};';
  assert.deepEqual(parseZappyhireBundle(bundleText), { backendHost: "fed.portal.zappyhire.com", generation: "new", source: null });
});

test("parseZappyhireBundle detects the legacy environment object (endpoint + source), ignoring chatEndPoint and unrelated source: literals", () => {
  const bundleText =
    'source:"imperative";' + // decoy from an unrelated Angular router literal
    '{production:!0,endpoint:"https://zappyhire-esaf-be-prod.zappyhire.com/",' +
    'chatEndPoint:"https://zappyhire-esaf-be-prod.zappyhire.com/",' +
    'chatUrl:"https://zappyhire-chatbot-fe-prod.zappyhire.com/",source:"ESAF"}';
  assert.deepEqual(parseZappyhireBundle(bundleText), {
    backendHost: "zappyhire-esaf-be-prod.zappyhire.com",
    generation: "legacy",
    source: "ESAF",
  });
});

test("parseZappyhireBundle returns null when neither environment signature is present", () => {
  assert.equal(parseZappyhireBundle("function foo(){return 1}"), null);
});

test("extractScriptUrls resolves script src and modulepreload link href against the page URL, dedups", () => {
  const html = `
    <link rel="modulepreload" href="chunk-Z77EVITP.js">
    <link rel="modulepreload" href="chunk-Z77EVITP.js">
    <script src="polyfills-FFHMD2TL.js" type="module"></script>
    <script src="main-K6IIGMC7.js" type="module"></script>
    <link rel="stylesheet" href="styles-UHGTUYPQ.css">
  `;
  const urls = extractScriptUrls(html, "https://federalbankcareers.zappyhire.com/");
  assert.deepEqual(
    new Set(urls),
    new Set([
      "https://federalbankcareers.zappyhire.com/chunk-Z77EVITP.js",
      "https://federalbankcareers.zappyhire.com/polyfills-FFHMD2TL.js",
      "https://federalbankcareers.zappyhire.com/main-K6IIGMC7.js",
    ]),
  );
});
