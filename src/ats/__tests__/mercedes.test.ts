// src/ats/mercedes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  mercedesSearchUrl,
  normalizeMercedes,
  mercedesJdFromHtml,
} from "../mercedes.js";
import type { MercedesDescriptor } from "../mercedes.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const SearchUrlQuerySchema = z.object({
  SearchParameters: z.object({ FirstItem: z.number(), CountItem: z.number() }),
  SearchCriteria: z.array(z.object({ CriterionName: z.string(), CriterionValue: z.array(z.string()) })),
});

const company: AdapterCompany = {
  provider: "mercedes",
  slug: "mercedes",
  name: "Mercedes-Benz India",
  careersUrl: "https://jobs.mercedes-benz.com/en",
  tenantUrl: null,
  apiMeta: null,
};

// Real fixture (trimmed) from jobs.api.mercedes-benz.com/search filtered to PositionLocation.Country=390 (India).
const descriptor: MercedesDescriptor = {
  PositionID: "mer00044ty",
  PositionTitle: "Senior Program Manager -IT Validation Solutions",
  PositionURI: "https://jobs.mercedes-benz.com/senior-program-manager--it-validation-solutions-226678-MER00044TY",
  PositionLocation: [
    {
      CityName: "Bangalore",
      DisplayName: "Mercedes-Benz Research and Development India Private Limited, Bangalore",
    },
  ],
  PublicationStartDate: "2026-07-01",
};

test("mercedesSearchUrl encodes an India-filtered, paged HR-Open query", () => {
  const url = mercedesSearchUrl(51, 50);
  assert.ok(url.startsWith("https://jobs.api.mercedes-benz.com/search?data="));
  const data = SearchUrlQuerySchema.parse(JSON.parse(decodeURIComponent(at(url.split("data="), 1))));
  assert.equal(data.SearchParameters.FirstItem, 51);
  assert.equal(data.SearchParameters.CountItem, 50);
  assert.deepEqual(data.SearchCriteria, [
    { CriterionName: "PositionLocation.Country", CriterionValue: ["390"] },
  ]);
});

test("normalizeMercedes maps PositionID as externalId, the PositionURI as jobUrl verbatim, and city location", () => {
  const p = normalizeMercedes(company, descriptor);
  assert.equal(p.provider, "mercedes");
  assert.equal(p.externalId, "mer00044ty");
  assert.equal(p.jobTitle, "Senior Program Manager -IT Validation Solutions");
  assert.equal(
    p.jobUrl,
    "https://jobs.mercedes-benz.com/senior-program-manager--it-validation-solutions-226678-MER00044TY",
  );
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-07-01").toISOString());
});

test("normalizeMercedes falls back to DisplayName when CityName is absent, and null when no location", () => {
  const p = normalizeMercedes(company, {
    ...descriptor,
    PositionLocation: [{ CityName: null, DisplayName: "Somewhere, HQ" }],
  });
  assert.equal(p.location, "Somewhere, HQ");
  const p2 = normalizeMercedes(company, { ...descriptor, PositionLocation: null });
  assert.equal(p2.location, null);
});

test("normalizeMercedes: unparseable PublicationStartDate maps to null", () => {
  const p = normalizeMercedes(company, { ...descriptor, PublicationStartDate: "not-a-date" });
  assert.equal(p.postedAt, null);
});

// Real fixture from the public job page's Nuxt JSON-LD island - the reason fetchJd scrapes the page since the search API never returns the description.
const jobPageHtml = `
<html><head>
<script>window.__NUXT__={config:{}}</script>
<script type="application/ld+json" data-nuxt-schema-org="true" data-hid="schema-org-graph">
{"@context":"https://schema.org","@graph":[
  {"@id":"https://jobs.mercedes-benz.com/#website","@type":"WebSite"},
  {"@id":"https://jobs.mercedes-benz.com/senior-program-manager-226678#job-posting","@type":"JobPosting",
   "datePosted":"2026-07-01",
   "description":"<h2>Aufgaben</h2><p>Lead the Engineering IT team.</p>",
   "title":"Senior Program Manager -IT Validation Solutions",
   "hiringOrganization":{"@type":"Organization","name":"Mercedes-Benz Research and Development India Private Limited"}}
]}
</script>
</head><body></body></html>
`;

test("mercedesJdFromHtml extracts + HTML-strips the description from the JobPosting node inside the @graph array", () => {
  const jd = mercedesJdFromHtml(jobPageHtml);
  assert.match(jd, /Lead the Engineering IT team/);
  assert.doesNotMatch(jd, /<h2>|<p>/);
});

test("mercedesJdFromHtml tolerates a bare JobPosting object (no @graph wrapper)", () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Bare Job","description":"Bare posting."}</script>`;
  assert.equal(mercedesJdFromHtml(html), "Bare posting.");
});

test("mercedesJdFromHtml returns '' when no ld+json script is present", () => {
  assert.equal(mercedesJdFromHtml("<html><body>no scripts here</body></html>"), "");
});

test("mercedesJdFromHtml skips an invalid JSON script block instead of throwing", () => {
  const html = `<script type="application/ld+json">{not valid json</script>` + jobPageHtml;
  const jd = mercedesJdFromHtml(html);
  assert.match(jd, /Lead the Engineering IT team/);
});
