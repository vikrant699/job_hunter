import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOracle, oracleAdapter } from "../oracle.js";
import type { AdapterCompany } from "../../types.js";
import { at, fetchSequence, htmlResponse, jsonResponse, stubFetch } from "./testHelpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";

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
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, "2026-06-02");
});

// A stale siteNumber does not filter the board to empty -- the pod ignores an unknown site rather than matching nothing, so it can over-collect but never look like [] (a dead pod fails loudly instead: 503/ENOTFOUND/timeout/404, never a well-formed empty page); these tests pin that a genuinely empty result stays [].

const emptyListResponse = {
  items: [{ SiteNumber: "CX_1", TotalJobsCount: 0, requisitionList: [] }],
};

const populatedListResponse = {
  items: [{ SiteNumber: "CX_1", TotalJobsCount: 1, requisitionList: [req] }],
};

test("oracleAdapter.listPostings returns [] for a live pod with no open requisitions", async (t) => {
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(jsonResponse(emptyListResponse));
  });
  assert.deepEqual(await oracleAdapter.listPostings(company), []);
  assert.equal(calls, 1, "zero requisitions ends pagination on the first page");
});

test("oracleAdapter.listPostings tolerates requisitionList being absent rather than empty", async (t) => {
  // Without the adapter's `expand` param the pod omits the key entirely; `?? []` keeps that an empty board rather than a crash.
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
  // three canned 503s: fetchOk retries retryable statuses before surfacing the error (Retry-After keeps the test fast)
  const dead = (): Response =>
    new Response("<HTML><HEAD><TITLE>Service Unavailable</TITLE></HEAD><BODY>DNS failure</BODY></HTML>", {
      status: 503,
      headers: { "Content-Type": "text/html", "Retry-After": "0.25" },
    });
  stubFetch(t, fetchSequence(dead, dead, dead));
  await assert.rejects(() => oracleAdapter.listPostings(company), /oracle HTTP 503/);
});

test("oracleAdapter.listPostings refuses to read a 404 resource path as an empty board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse("", 404)));
  await assert.rejects(() => oracleAdapter.listPostings(company), /oracle 404/);
});

test("a dead pod's HTTP status error stays chargeable to the company", async (t) => {
  // The 503 comes from the remote over a live socket, so it must count toward consecutive_failures, not be treated as infra/transport noise.
  stubFetch(t, fetchSequence(() => htmlResponse("<HTML><TITLE>Service Unavailable</TITLE></HTML>", 503)));
  const err = await oracleAdapter.listPostings(company).then(
    () => new Error("expected the call to reject, but it resolved"),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
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
  // limit/offset must stay INSIDE the finder; some pods ignore top-level &limit=&offset= and serve page 1 forever.
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
