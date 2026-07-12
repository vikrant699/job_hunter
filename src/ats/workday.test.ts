// src/ats/workday.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkdayListing, selectPartitionFacet, crawlWorkdayPostings } from "./workday.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { JsonValue } from "../util/json.js";

const company: AdapterCompany = {
  provider: "workday",
  slug: "accenture",
  name: "Accenture",
  careersUrl: "https://accenture.wd103.myworkdayjobs.com/AccentureCareers",
  tenantUrl: "https://accenture.wd103.myworkdayjobs.com/AccentureCareers",
  apiMeta: null,
};

test("normalizeWorkdayListing uses locationsText when present", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Software Engineer",
    externalPath: "/job/Bengaluru/Software-Engineer_R-00123",
    locationsText: "Bengaluru, Karnataka, India",
    postedOn: "Posted Today",
    bulletFields: ["R-00123", "Full time"],
    jobPostingId: "R-00123",
    shortId: null,
  });
  assert.equal(p.location, "Bengaluru, Karnataka, India");
});

test("normalizeWorkdayListing falls back to a bulletFields location when locationsText is missing", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Software Engineer",
    externalPath: "/job/Bengaluru/Software-Engineer_req-123",
    locationsText: null,
    postedOn: "Posted Today",
    bulletFields: ["req-123", "Bengaluru, India"],
    jobPostingId: "req-123",
    shortId: null,
  });
  assert.equal(p.location, "Bengaluru, India");
});

// Real Accenture (wd103) postings carry no jobPostingId/shortId/locationsText
// at all — bulletFields is just [reqId, location] and location is often a
// bare city name with no comma ("Milan", "London").
test("normalizeWorkdayListing falls back to a bare city-name bulletField (no comma, no jobPostingId/shortId)", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Workday Integration Developer",
    externalPath: "/job/Milan/Workday-Projects-Functional-Lead_R00304956",
    locationsText: null,
    postedOn: "Posted Yesterday",
    bulletFields: ["R00304956", "Milan"],
    jobPostingId: null,
    shortId: null,
  });
  assert.equal(p.location, "Milan");
});

test("normalizeWorkdayListing skips known non-location metadata bulletFields (e.g. employment type) to find the location", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Software Engineer",
    externalPath: "/job/Bengaluru/Software-Engineer_req-321",
    locationsText: null,
    postedOn: "Posted Today",
    bulletFields: ["req-321", "Full time", "40 hrs/week", "Bengaluru"],
    jobPostingId: "req-321",
    shortId: null,
  });
  assert.equal(p.location, "Bengaluru");
});

test("normalizeWorkdayListing stays null when only a req-id bulletField is present", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Software Engineer",
    externalPath: "/job/Bengaluru/Software-Engineer_req-456",
    locationsText: null,
    postedOn: "Posted Today",
    bulletFields: ["req-456"],
    jobPostingId: "req-456",
    shortId: null,
  });
  assert.equal(p.location, null);
});

test("normalizeWorkdayListing stays null when there are no bulletFields either", () => {
  const p = normalizeWorkdayListing(company, {
    title: "Software Engineer",
    externalPath: "/job/Bengaluru/Software-Engineer_req-789",
    locationsText: null,
    postedOn: "Posted Today",
    bulletFields: null,
    jobPostingId: "req-789",
    shortId: null,
  });
  assert.equal(p.location, null);
});

// --- selectPartitionFacet ---------------------------------------------
//
// Modeled on the real Genpact (wd108/External_Careers) facets response: a
// flat leaf facet (jobFamilyGroup, id+count per value) alongside a nested
// facet (locationMainGroup, whose single top-level value is itself a facet
// group with no id/count of its own — the real per-location leaves are one
// level deeper). Only flat leaf facets are safe to partition on with a
// single `appliedFacets` entry.

const jobFamilyGroupFacet: JsonValue = {
  facetParameter: "jobFamilyGroup",
  values: [
    { descriptor: "Digital Operations", id: "fam-1", count: 1613 },
    { descriptor: "Technology Solutions and Services", id: "fam-2", count: 643 },
    { descriptor: "Data and Analytics", id: "fam-3", count: 337 },
    { descriptor: "Finance", id: "fam-4", count: 63 },
  ],
};

const timeTypeFacet: JsonValue = {
  facetParameter: "timeType",
  values: [
    { descriptor: "Full time", id: "tt-1", count: 1900 },
    { descriptor: "Part time", id: "tt-2", count: 100 },
  ],
};

// Nested facet: its one top-level value is itself a facet group ("locations")
// with no id/count of its own — the real per-location leaves are one level
// deeper. Must be excluded from partition selection (see leafValuesOf).
const locationMainGroupFacet: JsonValue = {
  facetParameter: "locationMainGroup",
  values: [
    {
      facetParameter: "locations",
      descriptor: "Locations",
      values: [
        { descriptor: "Bengaluru JP", id: "loc-1", count: 3 },
        { descriptor: "Noida JP", id: "loc-2", count: 2 },
      ],
    },
  ],
};

const genpactStyleFacets: JsonValue[] = [jobFamilyGroupFacet, timeTypeFacet, locationMainGroupFacet];

test("selectPartitionFacet picks the flat leaf facet with the most values, skipping the nested one", () => {
  const facet = selectPartitionFacet(genpactStyleFacets, null);
  assert.ok(facet, "expected a facet to be selected");
  assert.equal(facet.param, "jobFamilyGroup");
  assert.equal(facet.values.length, 4);
});

test("selectPartitionFacet excludes a facet param already applied (e.g. the India country facet)", () => {
  const facet = selectPartitionFacet(genpactStyleFacets, "jobFamilyGroup");
  assert.ok(facet, "expected a fallback facet to be selected");
  assert.equal(facet.param, "timeType");
});

test("selectPartitionFacet returns null when there are no facets", () => {
  assert.equal(selectPartitionFacet(null, null), null);
  assert.equal(selectPartitionFacet([], null), null);
});

test("selectPartitionFacet returns null when every facet is nested or has fewer than 2 values", () => {
  const onlyNested: JsonValue[] = [locationMainGroupFacet];
  assert.equal(selectPartitionFacet(onlyNested, null), null);
});

// --- crawlWorkdayPostings -----------------------------------------------

function posting(externalId: string): NormalizedPosting {
  return {
    provider: "workday",
    externalId,
    companySlug: "genpact",
    companyName: "Genpact",
    jobTitle: `Job ${externalId}`,
    jobUrl: `https://genpact.wd108.myworkdayjobs.com/job/${externalId}`,
    location: "Bengaluru, India",
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
}

const genpactCompany: AdapterCompany = {
  provider: "workday",
  slug: "genpact",
  name: "Genpact",
  careersUrl: "https://genpact.wd108.myworkdayjobs.com/External_Careers",
  tenantUrl: "https://genpact.wd108.myworkdayjobs.com/External_Careers",
  apiMeta: null,
};

test("crawlWorkdayPostings does a plain crawl with no behavior change when total is not exactly 2000", async () => {
  // First page must be a full page (pageSize 20) so pagination doesn't stop
  // early on a short page — that would mask whether the second page (and its
  // offset) is fetched correctly via the injected fetchPage.
  const page0 = Array.from({ length: 20 }, (_, i) => posting(`p${i}`));
  const calls: Array<{ offset: number; facets: Record<string, string[]> }> = [];
  const items = await crawlWorkdayPostings(genpactCompany, {}, null, async (offset, facets) => {
    calls.push({ offset, facets });
    if (offset === 0) {
      return { items: page0, total: 21, facets: genpactStyleFacets };
    }
    return { items: [posting("c")], total: 21, facets: null };
  });
  assert.deepEqual(
    items.map((p) => p.externalId),
    [...page0.map((p) => p.externalId), "c"]
  );
  assert.deepEqual(
    calls.map((c) => c.offset),
    [0, 20]
  );
  // no facet ever applied beyond the caller-supplied base facets ({})
  assert.ok(calls.every((c) => Object.keys(c.facets).length === 0));
});

test("crawlWorkdayPostings partitions by the selected facet when total is exactly 2000, unioning by externalId", async () => {
  const calls: Array<{ offset: number; facets: Record<string, string[]> }> = [];
  const items = await crawlWorkdayPostings(genpactCompany, {}, null, async (offset, facets) => {
    calls.push({ offset, facets });
    if (Object.keys(facets).length === 0) {
      // initial unfiltered peek: reports the latched total + facets
      return { items: [posting("peek-a")], total: 2000, facets: genpactStyleFacets };
    }
    if (facets.jobFamilyGroup?.[0] === "fam-1") {
      return { items: [posting("fam1-a"), posting("fam1-b")], total: 1613, facets: null };
    }
    if (facets.jobFamilyGroup?.[0] === "fam-2") {
      return { items: [posting("fam2-a")], total: 643, facets: null };
    }
    if (facets.jobFamilyGroup?.[0] === "fam-3") {
      return { items: [posting("fam1-a")], total: 337, facets: null }; // duplicate of fam1-a, must dedup
    }
    if (facets.jobFamilyGroup?.[0] === "fam-4") {
      return { items: [], total: 63, facets: null };
    }
    throw new Error(`unexpected facets in test: ${JSON.stringify(facets)}`);
  });
  const ids = items.map((p) => p.externalId).sort();
  assert.deepEqual(ids, ["fam1-a", "fam1-b", "fam2-a"]);
  // the unfiltered peek's own item must NOT leak into the result (partitioned crawl replaces it)
  assert.ok(!ids.includes("peek-a"));
  // one partition call per facet value
  const partitionCalls = calls.filter((c) => "jobFamilyGroup" in c.facets);
  assert.equal(partitionCalls.length, 4);
});

test("crawlWorkdayPostings falls back to the flat (capped) crawl and does not throw when no partitionable facet exists", async () => {
  const items = await crawlWorkdayPostings(genpactCompany, {}, null, async (offset) => {
    if (offset === 0) {
      return { items: [posting("only-a")], total: 2000, facets: null };
    }
    return { items: [], total: 2000, facets: null };
  });
  assert.deepEqual(items.map((p) => p.externalId), ["only-a"]);
});

test("crawlWorkdayPostings still returns results (without throwing) when a partition itself re-latches at 2000", async () => {
  const items = await crawlWorkdayPostings(genpactCompany, {}, null, async (offset, facets) => {
    if (Object.keys(facets).length === 0) {
      return {
        items: [],
        total: 2000,
        facets: [
          {
            facetParameter: "jobFamilyGroup",
            values: [
              { descriptor: "Huge", id: "fam-huge", count: 2000 },
              { descriptor: "Small", id: "fam-small", count: 5 },
            ],
          },
        ],
      };
    }
    if (facets.jobFamilyGroup?.[0] === "fam-huge") {
      return { items: [posting("huge-a")], total: 2000, facets: null }; // still latched — logs a warning, keeps going
    }
    return { items: [posting("small-a")], total: 5, facets: null };
  });
  const ids = items.map((p) => p.externalId).sort();
  assert.deepEqual(ids, ["huge-a", "small-a"]);
});
