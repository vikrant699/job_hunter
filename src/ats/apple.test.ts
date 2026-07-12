// src/ats/apple.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appleSearchBody,
  normalizeApple,
  appleJobNumberFromUrl,
  appleJdText,
} from "./apple.js";
import type { AppleSearchResult } from "./apple.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "apple",
  slug: "apple",
  name: "Apple",
  careersUrl: "https://jobs.apple.com/en-in/search?location=india-IND",
  tenantUrl: null,
  apiMeta: null,
};

// Real fixture: a "PIPE" (evergreen Retail pipeline) result, single location.
const pipeResult: AppleSearchResult = {
  id: "PIPE-200313970",
  positionId: "200313970",
  postingTitle: "IN-Business Expert",
  transformedPostingTitle: "in-business-expert",
  postDateInGMT: "2026-07-12T03:49:08.392491130Z",
  homeOffice: false,
  locations: [
    {
      name: "India",
      countryName: "India",
    },
  ],
};

// Real fixture: a "REQ" multi-location result — `id` carries a per-location
// suffix ("-0321") that `positionId` doesn't, which is exactly why `id` (not
// `positionId`) is used as externalId.
const reqResult: AppleSearchResult = {
  id: "200615971-0321",
  positionId: "200615971",
  postingTitle: "Site Reliability Engineering Manager",
  transformedPostingTitle: "site-reliability-engineering-manager",
  postDateInGMT: "2026-06-23T15:05:48.088Z",
  homeOffice: false,
  locations: [{ name: "Bengaluru", countryName: "India" }],
};

test("appleSearchBody builds the exact body the SPA sends once filtered to India", () => {
  assert.deepEqual(appleSearchBody(3), {
    query: "",
    filters: { locations: ["postLocation-INDC"] },
    page: 3,
    locale: "en-in",
    sort: "",
    format: { longDate: "MMMM D, YYYY", mediumDate: "MMM D, YYYY" },
  });
});

test("normalizeApple maps a PIPE (evergreen) result: id as externalId, country-level location", () => {
  const p = normalizeApple(company, pipeResult);
  assert.equal(p.provider, "apple");
  assert.equal(p.externalId, "PIPE-200313970");
  assert.equal(p.jobTitle, "IN-Business Expert");
  assert.equal(p.jobUrl, "https://jobs.apple.com/en-in/details/200313970/in-business-expert");
  assert.equal(p.location, "India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-07-12T03:49:08.392491130Z").toISOString());
});

test("normalizeApple maps a REQ multi-location result: distinct id used as externalId, city-level location", () => {
  const p = normalizeApple(company, reqResult);
  assert.equal(p.externalId, "200615971-0321");
  assert.equal(p.jobUrl, "https://jobs.apple.com/en-in/details/200615971/site-reliability-engineering-manager");
  assert.equal(p.location, "Bengaluru");
});

test("normalizeApple: homeOffice true forces isRemote regardless of location text", () => {
  const p = normalizeApple(company, { ...reqResult, homeOffice: true });
  assert.equal(p.isRemote, true);
});

test("normalizeApple: unparseable postDateInGMT maps to null", () => {
  const p = normalizeApple(company, { ...pipeResult, postDateInGMT: "not-a-date" });
  assert.equal(p.postedAt, null);
});

test("appleJobNumberFromUrl recovers the numeric jobNumber from a details URL", () => {
  assert.equal(
    appleJobNumberFromUrl("https://jobs.apple.com/en-in/details/200615971/site-reliability-engineering-manager"),
    "200615971",
  );
});

test("appleJobNumberFromUrl returns null for an unrelated URL", () => {
  assert.equal(appleJobNumberFromUrl("https://jobs.apple.com/en-in/search"), null);
});

test("appleJdText joins the jobDetails sub-fields present, skipping missing ones", () => {
  const text = appleJdText({
    jobSummary: "Summary paragraph.",
    description: "Full description.",
    minimumQualifications: null,
    preferredQualifications: "Nice to have.",
  });
  assert.match(text, /Summary paragraph\./);
  assert.match(text, /Full description\./);
  assert.match(text, /Nice to have\./);
});

test("appleJdText returns empty string when every sub-field is missing", () => {
  assert.equal(appleJdText({}), "");
});
