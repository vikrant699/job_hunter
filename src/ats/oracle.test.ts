// src/ats/oracle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOracle, oracleAdapter } from "./oracle.js";
import type { AdapterCompany } from "../types.js";
import { at, fetchSequence, htmlResponse, jsonResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";

const company: AdapterCompany = {
  provider: "oracle", slug: "onsemi", name: "ON Semiconductor",
  careersUrl: "https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1",
  tenantUrl: "https://hctz.fa.us2.oraclecloud.com", apiMeta: { siteNumber: "CX_1" },
};

const req = {
  Id: "300001234567890", Title: "Senior Data Analyst",
  PostedDate: "2026-06-02", PrimaryLocation: "Bengaluru, KA, India", secondaryLocations: [],
};

test("normalizeOracle maps list metadata and builds the CE job URL", () => {
  const p = normalizeOracle(company, req);
  assert.equal(p.externalId, "300001234567890");
  assert.equal(p.jobTitle, "Senior Data Analyst");
  assert.equal(p.location, "Bengaluru, KA, India");
  assert.equal(p.jobUrl, "https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/300001234567890");
  assert.equal(p.jdText, ""); // two-phase
  assert.equal(p.postedAt, "2026-06-02");
});

// --- dead tenant safety (no guard needed — pinning the vendor's behaviour) -----
//
// Oracle needed no dead-tenant guard, and these tests exist so a future refactor
// cannot quietly remove the safety it already has. The suspected failure mode — a
// stale siteNumber on a live pod yielding [] — does NOT exist. Probed 2026-08-03
// across all 16 live rows with siteNumber=CX_9999: the pod echoes the value back
// in the response's SiteNumber field but does not filter on an unknown one, so the
// board comes back intact. Identical on 15 of 16 rows; on iabqiz (Vikram Solar) the
// bogus site returned MORE than the real one (36 requisitions vs 7), i.e. an
// unrecognised site drops the filter rather than matching nothing. So a stale
// siteNumber over-collects, which is a separate defect, but it can never look like
// an empty board.
//
// Every way a pod itself can be gone already fails loudly, and none of them
// produces a well-formed empty page: a nonexistent host under fa.ocs answers HTTP
// 503 "Service Unavailable - DNS failure", under fa.oraclecloud.com it is
// getaddrinfo ENOTFOUND, under fa.us2/fa.em3 the connection times out, and a
// mistyped resource path is a hard 404. Meanwhile a genuinely empty result is
// well-formed: items[0] is present with requisitionList: [] and TotalJobsCount: 0
// (reproduced on iabqiz and eeho with a nonsense keyword, and by paging past the
// end), which is exactly what must keep returning [].

const emptyListResponse = {
  items: [{ SiteNumber: "CX_1", TotalJobsCount: 0, requisitionList: [] }],
};

const populatedListResponse = {
  items: [{ SiteNumber: "CX_1", TotalJobsCount: 1, requisitionList: [req] }],
};

test("oracleAdapter.listPostings returns [] for a live pod with no open requisitions", async (t) => {
  // The shape a nonsense keyword and an off-the-end offset both produce, and the
  // one no dead pod has ever produced — so it must stay a plain empty board.
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(jsonResponse(emptyListResponse));
  });
  assert.deepEqual(await oracleAdapter.listPostings(company), []);
  // Zero requisitions ends pagination on the first page: no extra requests, and
  // above all no second call to some "does this site exist" oracle.
  assert.equal(calls, 1);
});

test("oracleAdapter.listPostings tolerates requisitionList being absent rather than empty", async (t) => {
  // Without the adapter's `expand` param the pod omits the key entirely; the
  // `?? []` keeps that an empty board rather than a crash.
  stubFetch(t, fetchSequence(() => jsonResponse({ items: [{ SiteNumber: "CX_1", TotalJobsCount: 0 }] })));
  assert.deepEqual(await oracleAdapter.listPostings(company), []);
});

test("oracleAdapter.listPostings still lists a populated board unchanged", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(populatedListResponse)));
  const postings = await oracleAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(at(postings, 0).externalId, "300001234567890");
  assert.equal(
    at(postings, 0).jobUrl,
    "https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/300001234567890",
  );
});

test("oracleAdapter.listPostings refuses to read a dead pod's 503 as an empty board", async (t) => {
  // What a nonexistent *.fa.ocs.oraclecloud.com host actually serves. atsFetchJson
  // must fail the row here, never resolve with [].
  stubFetch(t, fetchSequence(() =>
    htmlResponse("<HTML><HEAD><TITLE>Service Unavailable</TITLE></HEAD><BODY>DNS failure</BODY></HTML>", 503),
  ));
  await assert.rejects(() => oracleAdapter.listPostings(company), /oracle HTTP 503/);
});

test("oracleAdapter.listPostings refuses to read a 404 resource path as an empty board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse("", 404)));
  await assert.rejects(() => oracleAdapter.listPostings(company), /oracle 404/);
});

test("a dead pod's HTTP status error stays chargeable to the company", async (t) => {
  // 503 came FROM the remote, over a live socket, so it is per-company and MUST
  // count toward consecutive_failures. If any of these flipped true the scheduler
  // would retry the board forever and never quarantine it.
  stubFetch(t, fetchSequence(() => htmlResponse("<HTML><TITLE>Service Unavailable</TITLE></HTML>", 503)));
  const err = await oracleAdapter.listPostings(company).then(
    () => new Error("expected the call to reject, but it resolved"),
    (e: unknown) => e,
  );
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("oracleAdapter.listPostings refuses to run without tenant_url or apiMeta.siteNumber", async () => {
  await assert.rejects(
    () => oracleAdapter.listPostings({ ...company, tenantUrl: null }),
    /oracle requires tenant_url/,
  );
  await assert.rejects(
    () => oracleAdapter.listPostings({ ...company, apiMeta: null }),
    /oracle requires apiMeta\.siteNumber/,
  );
});

test("oracleAdapter.listPostings sends the row's own base and siteNumber inside the finder args", async (t) => {
  // Both come from the registry (tenant_url + api_meta), and limit/offset must stay
  // INSIDE the finder — some pods ignore top-level &limit=&offset= and would serve
  // page 1 forever. Icertis's siteNumber is the bare "1", not a CX_ value.
  const icertis: AdapterCompany = {
    provider: "oracle", slug: "icertis", name: "Icertis",
    careersUrl: "https://iaaviz.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Jobs-at-Icertis/",
    tenantUrl: "https://iaaviz.fa.ocs.oraclecloud.com/", apiMeta: { siteNumber: "1" },
  };
  let requested = "";
  stubFetch(t, (url) => {
    requested = String(url);
    return Promise.resolve(jsonResponse(emptyListResponse));
  });
  assert.deepEqual(await oracleAdapter.listPostings(icertis), []);
  // The trailing slash on tenant_url is stripped, not doubled.
  assert.match(requested, /^https:\/\/iaaviz\.fa\.ocs\.oraclecloud\.com\/hcmRestApi\//);
  assert.match(requested, /finder=findReqs;siteNumber=1,limit=200,offset=0/);
});
