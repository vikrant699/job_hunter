// src/ats/zwayam-public.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  zwayamPublicAdapter,
  zwayamPublicFilterCri,
  zwayamPublicPage,
  zwayamPublicSearchUrl,
  zwayamPublicTenantPath,
  normalizeZwayamPublic,
} from "../zwayam-public.js";
import type { ZwayamPublicHit } from "../zwayam-public.js";
import type { AdapterCompany } from "../../types.js";
import { at, stubFetch } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "zwayam-public", slug: "max-life-insurance", name: "Max Life Insurance",
  careersUrl: "https://career.axismaxlife.com/axismaxlife/",
  tenantUrl: "https://career.axismaxlife.com/axismaxlife/",
  apiMeta: null,
};

// Trimmed from the real https://public.zwayam.com/jobs/search response for
// domain=career.axismaxlife.com (verified live 2026-08-01, companyId 15865).
const hitWithShortJd: ZwayamPublicHit = {
  _id: 961558,
  _source: {
    jobTitle: "Regional Head - Affluent Banking",
    jobUrl: "regional-head-affluent-banking-west-bengal-2026062612093862",
    locationSeparatedbySlash: "West Bengal",
    shortDescription: "Regional Head - Affluent Banking",
    mediumDescription: "<p>Full JD preview only.</p>",
    mediumDescriptionWithoutHtml: "Regional Head full body. ".repeat(20),
    createdDate: 1782455389000,
    jobCreatedDate: 1782455978000,
  },
};

const hitWithRichShortJd: ZwayamPublicHit = {
  _id: 953669,
  _source: {
    jobTitle: "Digital Sales Manager",
    jobUrl: "digital-sales-manager-maharashtra-2026",
    locationSeparatedbySlash: "Maharashtra",
    shortDescription: "<p>Drive digital sales across the region. <strong>Own the P&amp;L.</strong></p>",
    mediumDescription: null,
    mediumDescriptionWithoutHtml: null,
    createdDate: 1780000000000,
    jobCreatedDate: null,
  },
};

test("zwayamPublicFilterCri encodes the fixed sort criteria with the given pagination offset", () => {
  assert.deepEqual(JSON.parse(zwayamPublicFilterCri(10)), {
    paginationStartNo: 10,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
});

test("zwayamPublicSearchUrl defaults to the public.zwayam.com shard", () => {
  assert.equal(zwayamPublicSearchUrl(company), "https://public.zwayam.com/jobs/search");
  assert.equal(zwayamPublicSearchUrl({ ...company, apiMeta: {} }), "https://public.zwayam.com/jobs/search");
});

test("zwayamPublicSearchUrl honours apiMeta.apiHost for a tenant on another shard", () => {
  assert.equal(
    zwayamPublicSearchUrl({ ...company, apiMeta: { apiHost: "apic2.zwayam.com" } }),
    "https://apic2.zwayam.com/jobs/search",
  );
});

test("zwayamPublicPage unwraps data.data + totalCount + hasMoreData from a live-shaped response", () => {
  const raw = {
    code: 200,
    data: { data: [hitWithShortJd, hitWithRichShortJd], totalCount: 6350, hasMoreData: true },
  };
  const page = zwayamPublicPage(raw);
  assert.equal(page.total, 6350);
  assert.equal(page.hasMoreData, true);
  assert.equal(page.hits.length, 2);
  assert.equal(page.hits[0]?._source.jobTitle, "Regional Head - Affluent Banking");
});

test("zwayamPublicPage handles an empty last page", () => {
  const raw = { code: 200, data: { data: [], totalCount: 6350, hasMoreData: false } };
  const page = zwayamPublicPage(raw);
  assert.equal(page.hits.length, 0);
  assert.equal(page.total, 6350);
});

test("zwayamPublicPage throws on a malformed response (missing data.data) - schema mismatch", () => {
  assert.throws(() => zwayamPublicPage({ code: 400, message: "Bad Request" }));
  assert.throws(() => zwayamPublicPage(null));
});

// A tenant queried against the WRONG shard 200s with `data: null` rather than
// an empty board, so a mis-set apiMeta.apiHost surfaces as a schema mismatch
// (a hard company failure) instead of silently reporting zero postings.
test("zwayamPublicPage throws on the wrong-shard response (data: null), rather than reading as an empty board", () => {
  assert.throws(() => zwayamPublicPage({ code: 200, data: null }));
});

test("zwayamPublicPage's hit schema rejects a record with no id", () => {
  const raw = { code: 200, data: { data: [{ _source: hitWithShortJd._source }], totalCount: 1 } };
  assert.throws(() => zwayamPublicPage(raw));
});

test("zwayamPublicTenantPath extracts the first path segment (which may differ from the registry slug)", () => {
  assert.equal(zwayamPublicTenantPath("https://career.axismaxlife.com/axismaxlife/"), "axismaxlife");
  assert.equal(zwayamPublicTenantPath("https://careers.cyient.com/cyient/jobslist"), "cyient");
  // Bajaj Allianz: registry slug is "bajaj-allianz", tenant path is "bajajgeneral".
  assert.equal(zwayamPublicTenantPath("https://jobs.bajajgeneral.com/bajajgeneral/"), "bajajgeneral");
});

test("zwayamPublicTenantPath throws on a URL with no path segments", () => {
  assert.throws(() => zwayamPublicTenantPath("https://career.axismaxlife.com/"));
});

test("normalizeZwayamPublic maps title/location/remote/jobUrl, preferring the fullest JD text", () => {
  const p = normalizeZwayamPublic(company, hitWithShortJd, "https://career.axismaxlife.com", "axismaxlife");
  assert.equal(p.provider, "zwayam-public");
  assert.equal(p.externalId, "961558");
  assert.equal(p.jobTitle, "Regional Head - Affluent Banking");
  assert.equal(p.location, "West Bengal");
  assert.equal(
    p.jobUrl,
    "https://career.axismaxlife.com/axismaxlife/jobview/regional-head-affluent-banking-west-bengal-2026062612093862",
  );
  assert.equal(p.isRemote, false);
  // shortDescription equals the title here, so mediumDescriptionWithoutHtml (the longer field) wins.
  assert.match(p.jdText, /Regional Head full body\./);
  assert.equal(p.postedAt, new Date(1782455389000).toISOString());
});

test("normalizeZwayamPublic strips HTML when shortDescription itself carries the full JD", () => {
  const p = normalizeZwayamPublic(company, hitWithRichShortJd, "https://career.axismaxlife.com", "axismaxlife");
  assert.match(p.jdText, /Drive digital sales across the region\. Own the P&L\./);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
  assert.equal(p.postedAt, new Date(1780000000000).toISOString());
});

test("normalizeZwayamPublic detects a remote location and falls back to the numeric id when jobUrl is absent", () => {
  const remoteHit: ZwayamPublicHit = {
    _id: 5,
    _source: { ...hitWithShortJd._source, jobUrl: null, locationSeparatedbySlash: "Remote, India" },
  };
  const p = normalizeZwayamPublic(company, remoteHit, "https://career.axismaxlife.com", "axismaxlife");
  assert.equal(p.isRemote, true);
  assert.equal(p.jobUrl, "https://career.axismaxlife.com/axismaxlife/jobview/5");
});

test("normalizeZwayamPublic: empty everything still returns a posting with empty JD text and null location", () => {
  const empty: ZwayamPublicHit = {
    _id: 7,
    _source: {
      jobTitle: "Untitled Role", jobUrl: null, locationSeparatedbySlash: null,
      shortDescription: null, mediumDescription: null, mediumDescriptionWithoutHtml: null,
      createdDate: null, jobCreatedDate: null,
    },
  };
  const p = normalizeZwayamPublic(company, empty, "https://career.axismaxlife.com", "axismaxlife");
  assert.equal(p.jdText, "");
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, null);
});

// Zwayam shards its tenants across more than one API host, and each host
// answers `data: null` for the other's tenants. Verified live 2026-08-02:
// careers.infoedge.com answers only on public.zwayam.com (5 rows/page), while
// jobs.bajajgeneral.com answers only on apic2.zwayam.com (10 rows/page).
const bajaj: AdapterCompany = {
  provider: "zwayam-public", slug: "bajaj-allianz", name: "Bajaj Allianz General Insurance",
  careersUrl: "https://jobs.bajajgeneral.com/bajajgeneral/",
  tenantUrl: "https://jobs.bajajgeneral.com/bajajgeneral/",
  apiMeta: { apiHost: "apic2.zwayam.com" },
};

// --- location backfill from jobLocationRecord ------------------------------

// The apic2 shard leaves `locationSeparatedbySlash` empty (swept live
// 2026-08-03: populated on 1 of Bajaj Allianz's 338 postings) and carries the
// real location in `jobLocationRecord` instead (non-empty on 336/338). The
// values below come from that sweep; the live rows also carry jobId/companyId/
// id/country/state/city, which the schema drops as unread.
const recordOnlyHit: ZwayamPublicHit = {
  _id: 5002832,
  _source: {
    jobTitle: "Sales Manager Bancassurance",
    jobUrl: "sales-manager-bancassurance-2026",
    locationSeparatedbySlash: null,
    shortDescription: "Sell through the bank channel.",
    mediumDescription: null,
    mediumDescriptionWithoutHtml: null,
    createdDate: 1780000000000,
    jobCreatedDate: null,
    jobLocationRecord: [{ formattedLocation: "Bengaluru, Karnataka, India", location: "Bangalore" }],
  },
};

/** The same posting shape with one `jobLocationRecord` of the given raw code +
 *  geocoded string — the two fields the backfill actually reads. */
function hitWithRecords(records: { location: string; formattedLocation: string }[]): ZwayamPublicHit {
  return {
    _id: 9001,
    _source: { ...recordOnlyHit._source, jobLocationRecord: records },
  };
}

test("normalizeZwayamPublic backfills location from jobLocationRecord when locationSeparatedbySlash is absent", () => {
  const p = normalizeZwayamPublic(bajaj, recordOnlyHit, "https://jobs.bajajgeneral.com", "bajajgeneral");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, false);
});

// "HO" is Bajaj's internal head-office marker, not a place. Zwayam's geocoder
// resolves it to the real town of Ho in Ghana, which checkLocation would then
// reject as out-of-region. Null instead, so the posting reaches the JD-text
// fallback (see the lateLocationCheck note in normalizeZwayamPublic).
test("normalizeZwayamPublic leaves location null for the HO head-office code rather than asserting Ghana", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([{ location: "HO", formattedLocation: "Ho, Volta Region, Ghana" }]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, null);
});

test("normalizeZwayamPublic treats the marker as head office however the tenant cased it", () => {
  for (const code of ["ho", "Ho", " hO "]) {
    const p = normalizeZwayamPublic(
      bajaj,
      hitWithRecords([{ location: code, formattedLocation: "Ho, Volta Region, Ghana" }]),
      "https://jobs.bajajgeneral.com",
      "bajajgeneral",
    );
    assert.equal(p.location, null, `code "${code}" should read as the head-office marker`);
  }
});

// The marker also appears with the office's name appended ("HO Commerce Zone"
// is Bajaj's Pune head office), which Zwayam geocodes to Akita, Japan — a
// harder reject than Ghana. Same class of bad data, same verdict.
test("normalizeZwayamPublic leaves location null for a named head-office code (HO Commerce Zone -> Japan)", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([{ location: "HO Commerce Zone", formattedLocation: "Akita, Akita, Japan" }]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, null);
});

// The guard must not swallow a genuine city that merely starts with those two
// letters: the marker is an all-caps abbreviation, "Ho Chi Minh City" is a name.
test("normalizeZwayamPublic does not mistake a genuine Ho Chi Minh City code for the head-office marker", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([{ location: "Ho Chi Minh City", formattedLocation: "Ho Chi Minh City, Vietnam" }]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, "Ho Chi Minh City, Vietnam");
});

// Info Edge (public shard) populates BOTH fields on 289 of its 293 postings.
// The slash field is what every prior run keyed on, including notifyKey's
// cross-run dedup, so it keeps winning even though the record is richer
// ("Pune" vs "Pune, Maharashtra, India").
test("normalizeZwayamPublic prefers a populated locationSeparatedbySlash over jobLocationRecord (Info Edge regression)", () => {
  const bothFields: ZwayamPublicHit = {
    _id: 923734,
    _source: {
      ...recordOnlyHit._source,
      locationSeparatedbySlash: "Pune",
      jobLocationRecord: [{ location: "Pune", formattedLocation: "Pune, Maharashtra, India" }],
    },
  };
  const p = normalizeZwayamPublic(company, bothFields, "https://careers.infoedge.com", "infoedge");
  assert.equal(p.location, "Pune");
});

test("normalizeZwayamPublic falls back to jobLocationRecord when the slash field is blank rather than null", () => {
  const blank: ZwayamPublicHit = {
    _id: 9002,
    _source: { ...recordOnlyHit._source, locationSeparatedbySlash: "   " },
  };
  const p = normalizeZwayamPublic(bajaj, blank, "https://jobs.bajajgeneral.com", "bajajgeneral");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
});

// Multi-entry records are rare (4 of 338) and in 3 of the 4 the FIRST entry is
// the head-office artefact while the real city sits second — so "take [0]"
// would throw away the good row.
test("normalizeZwayamPublic skips a head-office entry to reach the real city in a multi-entry record", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([
      { location: "HO", formattedLocation: "Ho, Volta Region, Ghana" },
      { location: "Pune, Maharashtra, India", formattedLocation: "Pune, Maharashtra, India" },
    ]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, "Pune, Maharashtra, India");
});

test("normalizeZwayamPublic returns null when every jobLocationRecord entry is head-office-coded", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([
      { location: "HO", formattedLocation: "Ho, Volta Region, Ghana" },
      { location: "HO Commerce Zone", formattedLocation: "Akita, Akita, Japan" },
    ]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, null);
});

test("normalizeZwayamPublic yields null (not a throw) for an absent, empty or unusable jobLocationRecord", () => {
  const origin = "https://jobs.bajajgeneral.com";
  const noField: ZwayamPublicHit = {
    _id: 9003,
    _source: { ...recordOnlyHit._source, jobLocationRecord: undefined },
  };
  assert.equal(normalizeZwayamPublic(bajaj, noField, origin, "bajajgeneral").location, null);

  const nullField: ZwayamPublicHit = {
    _id: 9004,
    _source: { ...recordOnlyHit._source, jobLocationRecord: null },
  };
  assert.equal(normalizeZwayamPublic(bajaj, nullField, origin, "bajajgeneral").location, null);

  // 2 of Bajaj's 338 postings ship the array empty.
  assert.equal(normalizeZwayamPublic(bajaj, hitWithRecords([]), origin, "bajajgeneral").location, null);

  // Field-less / blank entries must be skipped, not emitted as "".
  const sparse: ZwayamPublicHit = {
    _id: 9005,
    _source: { ...recordOnlyHit._source, jobLocationRecord: [{}, { formattedLocation: "  " }] },
  };
  assert.equal(normalizeZwayamPublic(bajaj, sparse, origin, "bajajgeneral").location, null);
});

test("normalizeZwayamPublic derives isRemote from a backfilled location", () => {
  const p = normalizeZwayamPublic(
    bajaj,
    hitWithRecords([{ location: "WFH", formattedLocation: "Remote, India" }]),
    "https://jobs.bajajgeneral.com",
    "bajajgeneral",
  );
  assert.equal(p.location, "Remote, India");
  assert.equal(p.isRemote, true);
});

test("zwayamPublicPage keeps jobLocationRecord through boundary validation", () => {
  const raw = { code: 200, data: { data: [recordOnlyHit], totalCount: 338, hasMoreData: true } };
  const page = zwayamPublicPage(raw, "bajaj-allianz");
  assert.equal(at(page.hits, 0)._source.jobLocationRecord?.[0]?.formattedLocation, "Bengaluru, Karnataka, India");
});

// --- listPostings: per-tenant API host + pagination ------------------------

function makeHits(startId: number, n: number): ZwayamPublicHit[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: startId + i,
    _source: { ...hitWithShortJd._source, jobTitle: `Role ${startId + i}` },
  }));
}

function searchResponse(pageHits: ZwayamPublicHit[], totalCount: number): Response {
  return new Response(
    JSON.stringify({ code: 200, data: { data: pageHits, totalCount, hasMoreData: true } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** The multipart fields the adapter POSTed, as a plain map. */
function formFields(init: RequestInit | undefined): Record<string, string> {
  const body = init?.body;
  if (!(body instanceof FormData)) throw new Error("expected a multipart FormData body");
  const fields: Record<string, string> = {};
  for (const [k, v] of body.entries()) fields[k] = String(v);
  return fields;
}

const FilterCriSchema = z.object({ paginationStartNo: z.number() });

/** The offset the adapter asked for on this call, read back out of filterCri. */
function requestedOffset(init: RequestInit | undefined): number {
  const raw = formFields(init).filterCri ?? "";
  return FilterCriSchema.parse(JSON.parse(raw)).paginationStartNo;
}

test("listPostings targets apiMeta.apiHost, passing the tenant host as `domain`", async (t) => {
  const calls: { url: string; fields: Record<string, string> }[] = [];
  stubFetch(t, (input, init) => {
    calls.push({ url: String(input), fields: formFields(init) });
    return Promise.resolve(searchResponse(makeHits(1, 3), 3));
  });

  const postings = await zwayamPublicAdapter.listPostings(bajaj);

  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).url, "https://apic2.zwayam.com/jobs/search");
  // Only the API host is overridden — `domain` stays the TENANT host, which is
  // what selects the board on whichever shard serves it.
  assert.equal(at(calls, 0).fields.domain, "jobs.bajajgeneral.com");
  assert.equal(postings.length, 3);
  assert.equal(
    at(postings, 0).jobUrl,
    "https://jobs.bajajgeneral.com/bajajgeneral/jobview/regional-head-affluent-banking-west-bengal-2026062612093862",
  );
});

test("listPostings still targets public.zwayam.com when no apiMeta.apiHost is set (Info Edge / Max Life regression)", async (t) => {
  const urls: string[] = [];
  stubFetch(t, (input) => {
    urls.push(String(input));
    return Promise.resolve(searchResponse(makeHits(1, 5), 5));
  });

  const postings = await zwayamPublicAdapter.listPostings(company);

  assert.deepEqual(urls, ["https://public.zwayam.com/jobs/search"]);
  assert.equal(postings.length, 5);
});

test("listPostings walks every page of a tenant that serves 10 rows at a time", async (t) => {
  // apic2.zwayam.com serves 10 per page where public.zwayam.com serves 5, so
  // the page size is a property of the TENANT, not of the engine.
  const TOTAL = 25;
  const PER_PAGE = 10;
  const offsets: number[] = [];
  stubFetch(t, (_input, init) => {
    const start = requestedOffset(init);
    offsets.push(start);
    return Promise.resolve(searchResponse(makeHits(start + 1, Math.min(PER_PAGE, TOTAL - start)), TOTAL));
  });

  const postings = await zwayamPublicAdapter.listPostings(bajaj);

  assert.deepEqual(offsets, [0, 10, 20]);
  assert.equal(postings.length, TOTAL);
  assert.equal(at(postings, 0).externalId, "1");
  assert.equal(at(postings, TOTAL - 1).externalId, "25");
});

test("listPostings does not truncate a tenant serving fewer rows per page than the declared page size", async (t) => {
  // paginate() checks the short-page rule BEFORE the reported total, so a page
  // size guessed above what the tenant actually serves ended the board on page
  // 1 with `totalCount` sitting unread. Two shards already disagree (5 vs 10),
  // so no constant is safe here — the first page's own row count is.
  const TOTAL = 9;
  const PER_PAGE = 3;
  let calls = 0;
  stubFetch(t, (_input, init) => {
    const start = requestedOffset(init);
    calls++;
    return Promise.resolve(searchResponse(makeHits(start + 1, Math.min(PER_PAGE, TOTAL - start)), TOTAL));
  });

  const postings = await zwayamPublicAdapter.listPostings(company);

  assert.equal(postings.length, TOTAL, "must not stop at the first page");
  assert.equal(calls, 3);
});

test("listPostings stops on a board that ignores the offset and re-serves page 1", async (t) => {
  // The stall guard's page signature is built from dedupeBy, so without a
  // per-item key it is inert and an offset-ignoring board gets walked all the
  // way to `totalCount`, re-fetching the same rows (godrej-agrovet turned 3
  // real postings into 96 JD fetches this way on phenom).
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(searchResponse(makeHits(1, 10), 360));
  });

  const postings = await zwayamPublicAdapter.listPostings(bajaj);

  assert.equal(calls, 2, "the second identical page must end pagination");
  assert.equal(postings.length, 10, "the repeated rows must not be accumulated twice");
});
