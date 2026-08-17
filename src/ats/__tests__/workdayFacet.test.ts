// src/ats/workdayFacet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverIndiaFacet, descriptorIsIndia, pinnedFacet } from "../workdayFacet.js";
import { stubFetch, jsonResponse } from "./testHelpers.js";

const CXS = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External";

test("finds India in a flat facets[] tree via facetParameter", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationCountry", values: [
      { descriptor: "United States", id: "us-uuid" },
      { descriptor: "India", id: "india-uuid" },
    ] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locationCountry", uuids: ["india-uuid"] });
});

test("finds India nested one level down under refineFilters, falling back to node id", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    refineFilters: [{ id: "Location_Country", values: [
      { id: "group", values: [{ descriptor: " india ", id: "in-uuid" }], facetParameter: "Country_Region" },
    ] }],
  })));
  const got = await discoverIndiaFacet({ cxsBase: CXS });
  assert.deepEqual(got?.uuids, ["in-uuid"]);
  assert.equal(got.param, "Country_Region");
});

test("a BARE India leaf is accepted even under an oddly-named facet (redhat's country node id is 'a')", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "a", values: [{ descriptor: "India", id: "x" }] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "a", uuids: ["x"] });
});

test("composite city leaves are collected (hpe shape), Indiana never matches", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locations", values: [
      { descriptor: "Ahmedabad, Gujarat, India", id: "l1" },
      { descriptor: "India - Chennai", id: "l2" },
      { descriptor: "India Remote", id: "l3" },
      { descriptor: "USA - Indiana - Indianapolis", id: "bad1" },
      { descriptor: "Indiana", id: "bad2" },
      { descriptor: "London, UK", id: "bad3" },
    ] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locations", uuids: ["l1", "l2", "l3"] });
});

test("descriptorIsIndia is a token match, never substring", () => {
  assert.equal(descriptorIsIndia("India-Bangalore-Remote Location"), true);
  assert.equal(descriptorIsIndia("India, Gurgaon"), true);
  assert.equal(descriptorIsIndia("Indianapolis"), false);
  assert.equal(descriptorIsIndia("USA - Indiana"), false);
});

test("returns null when no India leaf exists", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationCountry", values: [{ descriptor: "Germany", id: "de" }] }],
  })));
  assert.equal(await discoverIndiaFacet({ cxsBase: CXS }), null);
});

// --- api_meta facet pin -------------------------------------------------------
//
// Some tenants (lowes LWS_External_CS, probed 2026-08-17) expose ONLY a flat
// per-city `locations` facet whose India leaves carry no "India" token
// ("Bengaluru"), so token-based discovery finds nothing and the adapter falls
// back to crawling the whole 11,823-job board. api_meta can pin the facet
// explicitly instead: facetParam + facetValueIds (comma-separated — ApiMeta
// values are strings).
test("pinnedFacet builds a DiscoveredFacet from api_meta, splitting comma-separated ids", () => {
  assert.deepEqual(
    pinnedFacet({ facetParam: "locations", facetValueIds: "aaa, bbb" }),
    { param: "locations", uuids: ["aaa", "bbb"] },
  );
  assert.deepEqual(
    pinnedFacet({ facetParam: "locations", facetValueIds: "02b0c958653f0132d890316014068cc5" }),
    { param: "locations", uuids: ["02b0c958653f0132d890316014068cc5"] },
  );
});

test("pinnedFacet is null when either key is absent, empty, or api_meta is null", () => {
  assert.equal(pinnedFacet(null), null);
  assert.equal(pinnedFacet({}), null);
  assert.equal(pinnedFacet({ facetParam: "locations" }), null);
  assert.equal(pinnedFacet({ facetValueIds: "aaa" }), null);
  assert.equal(pinnedFacet({ facetParam: "locations", facetValueIds: " , " }), null);
  // Unrelated api_meta keys (workday rows don't usually carry any) stay inert.
  assert.equal(pinnedFacet({ domain: "x.com" }), null);
});
