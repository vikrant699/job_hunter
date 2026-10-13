import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverIndiaFacet, descriptorIsIndia, descriptorIsIndianPlace, pinnedFacet } from "../workdayFacet.js";
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
  assert.equal(descriptorIsIndia("Hyderabad Office, India."), true);
  assert.equal(descriptorIsIndia("Bengaluru (India)"), true);
  assert.equal(descriptorIsIndia("India_Bangalore"), true);
  assert.equal(descriptorIsIndia("Indiana."), false);
});

test("returns null when no India leaf exists", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationCountry", values: [{ descriptor: "Germany", id: "de" }] }],
  })));
  assert.equal(await discoverIndiaFacet({ cxsBase: CXS }), null);
});

// Some tenants expose only a flat per-city `locations` facet whose India leaves carry no "India" token, so token-based discovery finds nothing; api_meta can pin the facet explicitly instead.
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
  assert.equal(pinnedFacet({ domain: "x.com" }), null);
});

// altera: the 9-posting Hyderabad office leaf is just "Regus, Madhapur", so token-only discovery never fetched it.
test("an India office leaf without the country token is selected beside the tokened one (altera shape)", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locationMainGroup", values: [{ facetParameter: "locations", values: [
      { descriptor: "Bengaluru, Karnataka, India", id: "blr", count: 34 },
      { descriptor: "Regus, Madhapur", id: "madhapur", count: 9 },
      { descriptor: "Portsmouth", id: "bad1", count: 2 },
      { descriptor: "TLV", id: "bad2", count: 4 },
      { descriptor: "San Jose, California, United States", id: "bad3", count: 68 },
    ] }] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locations", uuids: ["blr", "madhapur"] });
});

test("a country facet wins over a city facet listed before it", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [
      { facetParameter: "locations", values: [{ descriptor: "India - Pune", id: "pune", count: 3 }, { descriptor: "Bangalore", id: "blr", count: 30 }] },
      { facetParameter: "locationCountry", values: [{ descriptor: "United States", id: "us", count: 90 }, { descriptor: "India", id: "in", count: 33 }] },
    ],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locationCountry", uuids: ["in"] });
});

test("with no country facet, a city facet whose India leaves carry no country token is found", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [{ facetParameter: "locations", values: [
      { descriptor: "Bangalore Area", id: "blr", count: 230 },
      { descriptor: "Gurugram", id: "ggn", count: 6 },
      { descriptor: "Bangkok Area", id: "bad1", count: 14 },
      { descriptor: "Indianapolis, IN", id: "bad2", count: 1 },
    ] }],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locations", uuids: ["blr", "ggn"] });
});

test("among non-country facets the one covering the most India postings wins", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [
      { facetParameter: "locationRegionStateProvince", values: [{ descriptor: "Telangāna", id: "ts", count: 4 }, { descriptor: "Texas", id: "tx", count: 50 }] },
      { facetParameter: "locations", values: [{ descriptor: "Hyderabad", id: "hyd", count: 4 }, { descriptor: "Pune", id: "pune", count: 11 }] },
    ],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locations", uuids: ["hyd", "pune"] });
});

test("descriptorIsIndianPlace matches Indian cities, states and office districts by whole phrase", () => {
  for (const d of [
    "Regus, Madhapur", "Bangalore Area", "Gurugram", "Pune - GITDC", "India_Bangalore", "Whitefield",
    "HITEC City", "Tamil Nādu", "Telangāna", "New Delhi", "Manyata Tech Park", "Hinjewadi Phase 2", "Noida",
    "Gondia", "Ratnagiri", "Unnao", "Verna", "Mangrol", "Sumerpur Detergents Factory",
  ]) assert.equal(descriptorIsIndianPlace(d), true, d);
});

test("descriptorIsIndianPlace rejects foreign namesakes and US state codes", () => {
  for (const d of [
    "Indianapolis, IN", "US-IN-Remote Location", "1001 W 7th St, Auburn, IN 46706", "15811 Saint Clair Ave, Calcutta, OH 43920",
    "1405 Electric Rd, Salem, VA 24153", "Hyderabad, Sindh, Pakistan", "Bangkok Area", "Bangor, ME", "Coimbra", "Subang",
    "Punjab, Pakistan", "Kochi, Japan", "Winston Salem, NC", "45 Main St, Delhi, NY 13753", "Delhi, LA (Delhi Plant)", "Madras, OR",
    "Hajdu-Bihar", "Store 3005243 Delhi ON", "Delhi, ON",
  ]) assert.equal(descriptorIsIndianPlace(d), false, d);
});

// bristolmyerssquibb: the country level is "locationHierarchy2", recognisable only by its lone bare "India" leaf.
test("a facet whose only India leaf is bare 'India' is country-level whatever its param is named", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({
    facets: [
      { facetParameter: "locationHierarchy2", values: [{ descriptor: "India", id: "in", count: 58 }, { descriptor: "United States", id: "us", count: 400 }] },
      { facetParameter: "locations", values: [{ descriptor: "Hyderabad - TS - IN", id: "hyd", count: 53 }, { descriptor: "Field - India - IN", id: "field", count: 2 }, { descriptor: "Mumbai - MH - IN", id: "bom", count: 3 }, { descriptor: "Pune - MH - IN", id: "pnq", count: 1 }] },
    ],
  })));
  assert.deepEqual(await discoverIndiaFacet({ cxsBase: CXS }), { param: "locationHierarchy2", uuids: ["in"] });
});

// fis abbreviates its India sites ("IND HYDB 18-23 OB3"); allstate writes "Ind – Blr Sez 1"; neither names a known city.
test("descriptorIsIndianPlace accepts IND as a prefix, suffix or delimited segment, never IN (Indiana) or a bare mid-string IND", () => {
  for (const d of ["IND BNGL FL2-3 TWR 3", "IND HYDB 18-23 OB3", "Ind – Blr Sez 1 (3Rd, 6Th & 7Th Floor)", "IND:KA:Bangalore / Intl Tech Park", "Hyderabad, IND", "Bangalore,IND", "Field Worker - IND Cx", "Remote (IND)", "IND MHLI A-45 2ND FL"]) {
    assert.equal(descriptorIsIndianPlace(d), true, d);
  }
  for (const d of ["US PA IND 324 Client", "IN - Fort Wayne, 720 Taylor St", "Field-IN", "Store 2747502 Anderson IN", "Indianapolis", "IND0011 - Remote"]) {
    assert.equal(descriptorIsIndianPlace(d), false, d);
  }
});

test("descriptorIsIndianPlace keeps Indian codes that collide with US ones: TN (Tamil Nadu) and IN (India)", () => {
  for (const d of ["Home Office-MH,IND", "Hyderabad - TS - IN", "Chennai, TN", "Bengaluru, KA", "Nissan Digital Hub, Trivandrum, IN", "Delhi, DL", "Mohali, PB", "Remote - Delhi Regional Office", "IND Hyderabad - Hyderabad DC", "Patna PTNH DC"]) assert.equal(descriptorIsIndianPlace(d), true, d);
});
