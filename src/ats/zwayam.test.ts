// src/ats/zwayam.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zwayamFilterCri,
  zwayamPage,
  normalizeZwayam,
} from "./zwayam.js";
import type { ZwayamHit } from "./zwayam.js";
import type { AdapterCompany } from "../types.js";

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
