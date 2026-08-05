// src/ats/workday-facet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverIndiaFacet } from "../workday-facet.js";
import { stubFetch, jsonResponse } from "./test-helpers.js";

const CXS = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External";

test("finds India in a flat facets[] tree via facetParameter", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationCountry", values: [
      { descriptor: "United States", id: "us-uuid" },
      { descriptor: "India", id: "india-uuid" },
    ] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locationCountry", uuid: "india-uuid" });
});

test("finds India nested one level down under refineFilters, falling back to node id", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    refineFilters: [{ id: "Location_Country", values: [
      { id: "group", values: [{ descriptor: " india ", id: "in-uuid" }], facetParameter: "Country_Region" },
    ] }],
  })));
  const got = await discoverIndiaFacet({ cxsBase: CXS });
  assert.equal(got?.uuid, "in-uuid");
  assert.equal(got.param, "Country_Region");
});

test("ignores an India descriptor under a non-country facet", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "skills", values: [{ descriptor: "India", id: "x" }] }],
  })));
  assert.equal(await discoverIndiaFacet({ cxsBase: CXS }), null);
});

test("returns null when no India leaf exists", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationCountry", values: [{ descriptor: "Germany", id: "de" }] }],
  })));
  assert.equal(await discoverIndiaFacet({ cxsBase: CXS }), null);
});
