// src/ats/zwayam-public.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zwayamPublicFilterCri,
  zwayamPublicPage,
  zwayamPublicTenantPath,
  normalizeZwayamPublic,
} from "./zwayam-public.js";
import type { ZwayamPublicHit } from "./zwayam-public.js";
import type { AdapterCompany } from "../types.js";

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

test("zwayamPublicPage's hit schema rejects a record with no id", () => {
  const raw = { code: 200, data: { data: [{ _source: hitWithShortJd._source }], totalCount: 1 } };
  assert.throws(() => zwayamPublicPage(raw));
});

test("zwayamPublicTenantPath extracts the first path segment (which may differ from the registry slug)", () => {
  assert.equal(zwayamPublicTenantPath("https://career.axismaxlife.com/axismaxlife/"), "axismaxlife");
  assert.equal(zwayamPublicTenantPath("https://careers.cyient.com/cyient/jobslist"), "cyient");
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
