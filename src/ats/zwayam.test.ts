// src/ats/zwayam.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zwayamAdapter,
  zwayamFilterCri,
  zwayamPage,
  normalizeZwayam,
} from "./zwayam.js";
import type { ZwayamHit } from "./zwayam.js";
import type { AdapterCompany } from "../types.js";
import { at, fetchSequence, jsonResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";

const company: AdapterCompany = {
  provider: "zwayam", slug: "cyient", name: "Cyient",
  careersUrl: "https://careers.cyient.com/cyient/", tenantUrl: null,
  apiMeta: { companyId: "MTU0ODY=", tenantGroupId: "G1" },
};

// Realistic hit shapes captured live from careers.cyient.com — some tenants
// carry the full JD in shortDescription; others leave it near-empty (equal
// to the title) and put the real body in mediumDescriptionWithoutHtml.
const hitWithShortJd: ZwayamHit = {
  _id: 1134962,
  _source: {
    jobTitle: "Bogie Design Engineer",
    jobUrl: "bogie-design-engineer-bengaluru-india-20260628",
    locationSeparatedbySlash: "Bengaluru, India",
    shortDescription: "<p>Design bogies for rolling stock. <strong>Must know CATIA.</strong></p>",
    mediumDescription: null,
    mediumDescriptionWithoutHtml: null,
    createdDate: 1751000000000,
    jobCreatedDate: null,
  },
};

const hitWithMediumJd: ZwayamHit = {
  _id: 1138561,
  _source: {
    jobTitle: "Methods Engineer",
    jobUrl: "methods-engineer-montreal-canada-202607081101563",
    locationSeparatedbySlash: "Montreal, Quebec, Canada",
    shortDescription: "Methods Engineer",
    mediumDescription: "<p>Preview only.</p>",
    mediumDescriptionWithoutHtml: "Methods Engineer full body. ".repeat(20),
    createdDate: null,
    jobCreatedDate: 1783488717000,
  },
};

test("zwayamFilterCri encodes the fixed sort criteria with the given pagination offset", () => {
  assert.deepEqual(JSON.parse(zwayamFilterCri(20)), {
    paginationStartNo: 20,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
});

test("zwayamPage unwraps data.data + totalCount + hasMoreData from a live-shaped response", () => {
  const raw = {
    code: 200,
    data: { data: [hitWithShortJd, hitWithMediumJd], totalCount: 152, hasMoreData: true },
  };
  const page = zwayamPage(raw);
  assert.equal(page.total, 152);
  assert.equal(page.hasMoreData, true);
  assert.equal(page.hits.length, 2);
  assert.equal(page.hits[0]?._source.jobTitle, "Bogie Design Engineer");
});

test("zwayamPage handles an empty last page", () => {
  const raw = { code: 200, data: { data: [], totalCount: 152, hasMoreData: false } };
  const page = zwayamPage(raw);
  assert.equal(page.hits.length, 0);
  assert.equal(page.total, 152);
  assert.equal(page.hasMoreData, false);
});

test("zwayamPage throws on a malformed response (missing data.data)", () => {
  assert.throws(() => zwayamPage({ code: 200, data: { totalCount: 5 } }));
  assert.throws(() => zwayamPage({ nothing: "useful" }));
  assert.throws(() => zwayamPage(null));
});

test("normalizeZwayam: HTML-stripped JD, location, remote detection, job URL from the jobUrl slug", () => {
  const p = normalizeZwayam(company, hitWithShortJd, "https://careers.cyient.com", "cyient");
  assert.equal(p.provider, "zwayam");
  assert.equal(p.externalId, "1134962");
  assert.equal(p.jobTitle, "Bogie Design Engineer");
  assert.equal(p.jobUrl, "https://careers.cyient.com/cyient/jobview/bogie-design-engineer-bengaluru-india-20260628");
  assert.equal(p.location, "Bengaluru, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Design bogies for rolling stock\. Must know CATIA\./);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
  assert.equal(p.postedAt, new Date(1751000000000).toISOString());
});

test("normalizeZwayam falls back to mediumDescriptionWithoutHtml when shortDescription is just the title", () => {
  const p = normalizeZwayam(company, hitWithMediumJd, "https://careers.cyient.com", "cyient");
  assert.match(p.jdText, /Methods Engineer full body\./);
  assert.equal(p.postedAt, new Date(1783488717000).toISOString());
});

test("normalizeZwayam: remote location sets isRemote true", () => {
  const remoteHit: ZwayamHit = {
    _id: 5,
    _source: { ...hitWithShortJd._source, locationSeparatedbySlash: "Remote, India" },
  };
  const p = normalizeZwayam(company, remoteHit, "https://careers.cyient.com", "cyient");
  assert.equal(p.isRemote, true);
});

test("normalizeZwayam: falls back to the numeric id in the job URL when jobUrl slug is absent", () => {
  const noSlug: ZwayamHit = { _id: 42, _source: { ...hitWithShortJd._source, jobUrl: null } };
  const p = normalizeZwayam(company, noSlug, "https://careers.cyient.com", "cyient");
  assert.equal(p.jobUrl, "https://careers.cyient.com/cyient/jobview/42");
});

// --- dead tenant safety (no guard needed — pinning the vendor's behaviour) -----
//
// Zwayam needed no dead-tenant guard, and these tests exist so a future refactor
// cannot quietly remove the safety it already has. Probed 2026-08-03 against
// public.zwayam.com/jobs/search: the tenant selector is the `domain` field, NOT
// companyId. A domain Zwayam does not host answers HTTP 200 with
// {"code":200,...,"data":null,...} — `data.data` is absent, so parseOrThrow inside
// zwayamPage already fails the row instead of reporting an empty board.
//
// companyId turns out to be near-decorative: a valid-looking but wrong value
// (base64 of 999999) returned the DOMAIN's jobs, and outright garbage produced
// code 500 with data:null, which also throws. So no combination of stale tokens
// yields a silent [].
//
// The tenant/group endpoint is deliberately NOT used as an existence oracle: it
// answers {"name":"","tenantGroupId":""} for careers.livspace.com, a healthy live
// row, exactly as it does for a bogus host, so keying on it would have quarantined
// Livspace.

const liveCompany: AdapterCompany = {
  provider: "zwayam", slug: "cult", name: "Cult.fit",
  careersUrl: "https://careers.cult.fit/cult/jobslist",
  tenantUrl: "https://careers.cult.fit/cult/jobslist",
  apiMeta: { companyId: "MTU0NzA=", tenantGroupId: "G1" },
};

// Verbatim body for a domain Zwayam does not host (101 bytes, HTTP 200).
const DEAD_DOMAIN_RESPONSE = {
  code: 200, type: null, message: null, exception: null,
  data: null, webserviceAPIResponseCode: null,
};

// Verbatim envelope for a LIVE tenant whose search matches nothing — cult.fit
// with a nonsense keyword. data.data is present and empty, so it parses fine.
const EMPTY_BOARD_RESPONSE = {
  code: 200, type: null, message: null, exception: null,
  data: { data: [], facets: {}, totalCount: 0, hasMoreData: false },
  webserviceAPIResponseCode: null,
};

test("zwayamPage refuses to read a dead tenant's response as an empty board", () => {
  // The whole reason this adapter needs no marker: the shape a dead domain
  // returns cannot reach the empty-board path at all.
  assert.throws(() => zwayamPage(DEAD_DOMAIN_RESPONSE, "cult"), /zwayam page response failed schema for cult/);
  // ... and code 500 with the same null payload, which garbage companyId produces.
  assert.throws(() => zwayamPage({ ...DEAD_DOMAIN_RESPONSE, code: 500, message: "Internal Server Error" }, "cult"));
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", () => {
  // A domain Zwayam no longer hosts is a per-company board defect and MUST count
  // toward the row's consecutive_failures. If any of these flipped true the
  // scheduler would retry the board forever and never quarantine it.
  let err: unknown;
  try {
    zwayamPage(DEAD_DOMAIN_RESPONSE, "cult");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("zwayamAdapter.listPostings rejects a domain the vendor does not host", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(DEAD_DOMAIN_RESPONSE)));
  await assert.rejects(() => zwayamAdapter.listPostings(liveCompany), /zwayam page response failed schema for cult/);
});

test("zwayamAdapter.listPostings returns [] for a LIVE tenant whose search matches nothing", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(EMPTY_BOARD_RESPONSE)));
  assert.deepEqual(await zwayamAdapter.listPostings(liveCompany), []);
});

test("zwayamAdapter.listPostings still lists a populated board unchanged", async (t) => {
  stubFetch(t, fetchSequence(() =>
    jsonResponse({ code: 200, data: { data: [hitWithShortJd, hitWithMediumJd], totalCount: 2, hasMoreData: false } }),
  ));
  const postings = await zwayamAdapter.listPostings(liveCompany);
  assert.equal(postings.length, 2);
  assert.equal(at(postings, 0).externalId, "1134962");
  assert.equal(
    at(postings, 0).jobUrl,
    "https://careers.cult.fit/cult/jobview/bogie-design-engineer-bengaluru-india-20260628",
  );
});

test("zwayamAdapter.listPostings sends the tenant's own host as `domain` — the field the vendor keys on", async (t) => {
  // The stale-token audit hypothesis was that companyId selects the tenant. It
  // does not; `domain` does, which is why a dead one throws. Pinning the request
  // shape keeps that true through a refactor.
  const seen: { domain: string | null; companyId: string | null; group: string | null } = {
    domain: null, companyId: null, group: null,
  };
  stubFetch(t, (_url, init) => {
    const body = init?.body;
    if (body instanceof FormData) {
      const domain = body.get("domain");
      const companyId = body.get("companyId");
      if (typeof domain === "string") seen.domain = domain;
      if (typeof companyId === "string") seen.companyId = companyId;
    }
    seen.group = new Headers(init?.headers).get("TenantGroupId");
    return Promise.resolve(jsonResponse(EMPTY_BOARD_RESPONSE));
  });
  await zwayamAdapter.listPostings(liveCompany);
  assert.equal(seen.domain, "careers.cult.fit");
  assert.equal(seen.companyId, "MTU0NzA=");
  assert.equal(seen.group, "G1");
});

test("zwayamAdapter.listPostings refuses to run at all without both api_meta tokens", async () => {
  await assert.rejects(
    () => zwayamAdapter.listPostings({ ...liveCompany, apiMeta: { companyId: "MTU0NzA=" } }),
    /requires apiMeta\.companyId \+ apiMeta\.tenantGroupId/,
  );
  await assert.rejects(
    () => zwayamAdapter.listPostings({ ...liveCompany, apiMeta: null }),
    /requires apiMeta\.companyId \+ apiMeta\.tenantGroupId/,
  );
});

test("normalizeZwayam: empty everything still returns a posting with empty JD text and null location", () => {
  const empty: ZwayamHit = {
    _id: 7,
    _source: {
      jobTitle: "Untitled Role",
      jobUrl: null,
      locationSeparatedbySlash: null,
      shortDescription: null,
      mediumDescription: null,
      mediumDescriptionWithoutHtml: null,
      createdDate: null,
      jobCreatedDate: null,
    },
  };
  const p = normalizeZwayam(company, empty, "https://careers.cyient.com", "cyient");
  assert.equal(p.jdText, "");
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, null);
});
