// src/ats/zwayam.test.ts
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  zwayamAdapter,
  zwayamFilterCri,
  zwayamPage,
  normalizeZwayam,
} from "../zwayam.js";
import type { ZwayamHit } from "../zwayam.js";
import type { AdapterCompany } from "../../types.js";
import { asJson, at, fetchSequence, jsonResponse, stubFetch } from "./testHelpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";

const company: AdapterCompany = {
  provider: "zwayam", slug: "cyient", name: "Cyient",
  careersUrl: "https://careers.cyient.com/cyient/", tenantUrl: null,
  apiMeta: { companyId: "MTU0ODY=", tenantGroupId: "G1" },
};

// Some tenants carry the full JD in shortDescription; others leave it near the title and use mediumDescriptionWithoutHtml instead.
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
  const page = zwayamPage(asJson(raw));
  assert.equal(page.total, 152);
  assert.equal(page.hasMoreData, true);
  assert.equal(page.hits.length, 2);
  assert.equal(page.hits[0]?._source.jobTitle, "Bogie Design Engineer");
});

test("zwayamPage handles an empty last page", () => {
  const raw = { code: 200, data: { data: [], totalCount: 152, hasMoreData: false } };
  const page = zwayamPage(asJson(raw));
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

// Zwayam needs no dead-tenant guard: an unhosted domain answers 200 with data.data
// absent, which parseOrThrow already fails instead of reading as an empty board.
// The tenant selector is `domain`, not companyId - a wrong companyId still returns
// the domain's own jobs, so no combination of stale tokens yields a silent [].
// The tenant/group endpoint is deliberately not used as an existence oracle: it
// answers blank for a healthy tenant (Livspace) same as for a bogus host.

const liveCompany: AdapterCompany = {
  provider: "zwayam", slug: "cult", name: "Cult.fit",
  careersUrl: "https://careers.cult.fit/cult/jobslist",
  tenantUrl: "https://careers.cult.fit/cult/jobslist",
  apiMeta: { companyId: "MTU0NzA=", tenantGroupId: "G1" },
};

// Shape returned for a domain Zwayam does not host (HTTP 200, data: null).
const DEAD_DOMAIN_RESPONSE = {
  code: 200, type: null, message: null, exception: null,
  data: null, webserviceAPIResponseCode: null,
};

// Shape for a live tenant whose search matches nothing: data.data present but empty.
const EMPTY_BOARD_RESPONSE = {
  code: 200, type: null, message: null, exception: null,
  data: { data: [], facets: {}, totalCount: 0, hasMoreData: false },
  webserviceAPIResponseCode: null,
};

test("zwayamPage refuses to read a dead tenant's response as an empty board", () => {
  assert.throws(() => zwayamPage(DEAD_DOMAIN_RESPONSE, "cult"), /zwayam page response failed schema for cult/);
  assert.throws(() => zwayamPage({ ...DEAD_DOMAIN_RESPONSE, code: 500, message: "Internal Server Error" }, "cult"));
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", () => {
  // Must count as a company failure, not infrastructure, or the scheduler retries forever without quarantining.
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
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

// Page size is a per-tenant property, not fixed by the engine - different domains serve different row counts at the same endpoint.

const livspace: AdapterCompany = {
  provider: "zwayam", slug: "livspace", name: "Livspace",
  careersUrl: "https://careers.livspace.com/livspace/",
  tenantUrl: "https://careers.livspace.com/livspace/",
  apiMeta: { companyId: "MTU5MTk=", tenantGroupId: "G1" },
};

const sony: AdapterCompany = {
  provider: "zwayam", slug: "sonyindiasoftware", name: "Sony India",
  careersUrl: "https://careers.sonyindiasoftware.co.in/sonyindiasoftware/jobslist",
  tenantUrl: "https://careers.sonyindiasoftware.co.in/sonyindiasoftware/jobslist",
  apiMeta: { companyId: "MTU1MzI=", tenantGroupId: "G1" },
};

/** `n` hits with sequential ids from `startId`, so cross-page identity is real. */
function makeHits(startId: number, n: number): ZwayamHit[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: startId + i,
    _source: { ...hitWithShortJd._source, jobTitle: `Role ${startId + i}` },
  }));
}

function searchResponse(hits: ZwayamHit[], totalCount: number | null): Response {
  return jsonResponse({ code: 200, data: { data: hits, totalCount, hasMoreData: true } });
}

const FilterCriSchema = z.object({ paginationStartNo: z.number() });

/** The offset the adapter asked for on this call, read back out of filterCri. */
function requestedOffset(init: RequestInit | undefined): number {
  const body = init?.body;
  if (!(body instanceof FormData)) throw new Error("test stub: expected a multipart FormData body");
  const raw = body.get("filterCri");
  if (typeof raw !== "string") throw new Error("test stub: expected a filterCri field");
  return FilterCriSchema.parse(JSON.parse(raw)).paginationStartNo;
}

/** Serve a `perPage`-row window of a `total`-row board at the requested offset; returns offsets requested. */
function stubBoard(t: TestContext, total: number, perPage: number): number[] {
  const offsets: number[] = [];
  stubFetch(t, (_input, init) => {
    const start = requestedOffset(init);
    offsets.push(start);
    const rows = Math.max(0, Math.min(perPage, total - start));
    return Promise.resolve(searchResponse(makeHits(start + 1, rows), total));
  });
  return offsets;
}

test("listPostings collects all 100 postings of a tenant that serves 9 rows a page (Livspace)", async (t) => {
  // A hardcoded page size of 10 judged Livspace's own 9-row first page short, silently truncating to 9 of 100.
  const offsets = stubBoard(t, 100, 9);

  const postings = await zwayamAdapter.listPostings(livspace);

  assert.equal(postings.length, 100, "the whole board, not just the first page");
  assert.deepEqual(offsets, [0, 9, 18, 27, 36, 45, 54, 63, 72, 81, 90, 99]);
  assert.equal(at(postings, 0).externalId, "1");
  assert.equal(at(postings, 99).externalId, "100");
});

test("listPostings is unchanged on a tenant that really does serve 10 rows a page (cult.fit regression)", async (t) => {
  const offsets = stubBoard(t, 25, 10);

  const postings = await zwayamAdapter.listPostings(liveCompany);

  assert.deepEqual(offsets, [0, 10, 20], "stops on the genuinely short final page");
  assert.equal(postings.length, 25);
});

test("listPostings terminates on a single-page board smaller than the page size (Sony India regression)", async (t) => {
  // With an inferred page size the first page can't be short against itself, so the reported total ends it in one fetch.
  const offsets = stubBoard(t, 9, 9);

  const postings = await zwayamAdapter.listPostings(sony);

  assert.deepEqual(offsets, [0], "the reported total ends it without a second fetch");
  assert.equal(postings.length, 9);
});

test("listPostings terminates on a full-page board that reports no total, via the empty next page", async (t) => {
  // Guessing the page size low costs at most one extra fetch; with no total, the empty page ends it.
  const offsets: number[] = [];
  stubFetch(t, (_input, init) => {
    const start = requestedOffset(init);
    offsets.push(start);
    return Promise.resolve(searchResponse(start === 0 ? makeHits(1, 9) : [], null));
  });

  const postings = await zwayamAdapter.listPostings(livspace);

  assert.deepEqual(offsets, [0, 9]);
  assert.equal(postings.length, 9);
});

test("listPostings stops on a board that ignores the offset and re-serves page 1", async (t) => {
  // The stall guard needs a dedupeBy key or an offset-ignoring board gets walked to totalCount, re-fetching the same page.
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(searchResponse(makeHits(1, 9), 100));
  });

  const postings = await zwayamAdapter.listPostings(livspace);

  assert.equal(calls, 2, "the second identical page must end pagination");
  assert.equal(postings.length, 9, "the repeated rows must not be accumulated twice");
});

test("listPostings keeps crawling an overlapping page but accumulates each posting once", async (t) => {
  // Overlapping-but-not-identical pages mean the board reordered mid-crawl, not a stall.
  const offsets: number[] = [];
  stubFetch(t, (_input, init) => {
    const start = requestedOffset(init);
    offsets.push(start);
    // Page 2 re-serves ids 5-9 alongside the 4 genuinely new ones.
    return Promise.resolve(searchResponse(makeHits(start === 0 ? 1 : 5, 9), 13));
  });

  const postings = await zwayamAdapter.listPostings(livspace);

  assert.deepEqual(offsets, [0, 9]);
  assert.equal(postings.length, 13, "9 + 4 new, with the 5 repeats collapsed");
  assert.equal(at(postings, 12).externalId, "13");
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
