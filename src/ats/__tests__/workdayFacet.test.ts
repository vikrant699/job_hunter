// src/ats/workdayFacet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverIndiaFacet, descriptorIsIndia } from "../workdayFacet.js";
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
