import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWorkdayListing,
  selectPartitionFacet,
  crawlWorkdayPostings,
  parseWorkdayListPage,
  parseWorkdaySites,
  workdayAdapter,
} from "../workday.js";
import { asJson, stubFetch, jsonResponse, htmlResponse, mkAdapterCompany, at } from "./testHelpers.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";
import type { JsonValue } from "../../util/json.js";

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

// Real Accenture (wd103) postings carry no jobPostingId/shortId/locationsText - bulletFields is just [reqId, location], often a bare city name.
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

// Modeled on the real Genpact (wd108) facets response.
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

// Nested facet - its real per-location leaves are one level deeper, so it must be excluded from partition selection (see leafValuesOf).
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
  // First page must be full (20) so pagination doesn't stop early, masking whether the offset-based fetch works.
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
  const items = await crawlWorkdayPostings(genpactCompany, {}, null, async (_offset, facets) => {
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

// A stub jobPosting (no title/externalPath) must not fail the whole board - it was costing 1000+ postings per tenant per run.
const completePosting = {
  title: "Software Engineer",
  externalPath: "/job/Pune/Software-Engineer_R-1",
  locationsText: "Pune, India",
  postedOn: "Posted Today",
  bulletFields: ["R-1"],
  jobPostingId: "R-1",
  shortId: null,
};

test("parseWorkdayListPage skips a stub jobPosting instead of failing the board", () => {
  const page = parseWorkdayListPage(
    asJson({
      total: 3,
      jobPostings: [completePosting, { bulletFields: [] }, { ...completePosting, jobPostingId: "R-2" }],
    }),
    "barclays",
  );
  assert.equal(page.postings.length, 2);
  assert.equal(page.skipped, 1);
  assert.equal(page.total, 3);
});

test("parseWorkdayListPage still throws when EVERY posting fails the item schema (field drift, not stubs)", () => {
  assert.throws(
    () =>
      parseWorkdayListPage(
        asJson({ total: 2, jobPostings: [{ titleText: "a" }, { titleText: "b" }] }),
        "barclays",
      ),
    /schema/,
  );
});

test("parseWorkdayListPage passes an empty page through (end of pagination, not drift)", () => {
  const page = parseWorkdayListPage(asJson({ total: 0, jobPostings: [] }), "barclays");
  assert.equal(page.postings.length, 0);
  assert.equal(page.skipped, 0);
  assert.equal(page.total, null);
});

test("parseWorkdayListPage still throws when the envelope itself is wrong", () => {
  assert.throws(() => parseWorkdayListPage(asJson({ error: "nope" }), "barclays"), /schema/);
});

// --- parseWorkdaySites ------------------------------------------------------

test("parseWorkdaySites extracts sites from a mix of Allow and Sitemap lines, deduped in order", () => {
  const robots = [
    "User-agent: *",
    "Allow: /wday/",
    "Allow: /External/",
    "Allow: /External/", // duplicate, must not repeat in output
    "Sitemap: https://acme.wd1.myworkdayjobs.com/wday/sitemap/External/siteMap.xml",
    "Sitemap: https://acme.wd1.myworkdayjobs.com/wday/sitemap/Campus/siteMap.xml",
  ].join("\n");
  assert.deepEqual(parseWorkdaySites(robots), ["External", "Campus"]);
});

test("parseWorkdaySites reads a sitemap-only robots.txt", () => {
  const robots = "Sitemap: https://acme.wd1.myworkdayjobs.com/wday/sitemap/Careers/siteMap.xml\r\n";
  assert.deepEqual(parseWorkdaySites(robots), ["Careers"]);
});

test("parseWorkdaySites returns [] for garbage text with no Allow/Sitemap directives", () => {
  assert.deepEqual(parseWorkdaySites("User-agent: *\nDisallow: /admin/\n\nnot a directive at all"), []);
});

test("parseWorkdaySites excludes wday/refreshFacet/events and dotted names, case-insensitively", () => {
  const robots = [
    "allow: /wday/",
    "ALLOW: /refreshFacet/",
    "Allow: /events/",
    "Allow: /sitemap.External/", // dotted, excluded
    "Allow: /External/",
  ].join("\r\n");
  assert.deepEqual(parseWorkdaySites(robots), ["External"]);
});

test("parseWorkdaySites tolerates \\r\\n line endings", () => {
  const robots = "Allow: /wday/\r\nAllow: /External/\r\nAllow: /Campus\r\n";
  assert.deepEqual(parseWorkdaySites(robots), ["External", "Campus"]);
});

// --- workdayAdapter.listPostings: site-drift fallback ----------------------

const driftCompany: AdapterCompany = mkAdapterCompany(
  {
    provider: "workday",
    slug: "acme",
    name: "Acme",
    careersUrl: "https://acme.wd1.myworkdayjobs.com/External",
  },
  {
    tenantUrl: "https://acme.wd1.myworkdayjobs.com/External",
    // Pinned facet so discoverIndiaFacet's own probe request never runs - keeps the fetch sequence in these tests down to exactly the listing calls being exercised.
    apiMeta: { facetParam: "locationCountry", facetValueIds: "in-1" },
  },
);

function driftListResponse(site: string) {
  return {
    total: 1,
    jobPostings: [
      {
        title: `Engineer at ${site}`,
        externalPath: "/job/Pune/Engineer_R1",
        locationsText: "Pune, India",
        postedOn: "Posted Today",
        bulletFields: ["R1"],
        jobPostingId: "R1",
        shortId: null,
      },
    ],
  };
}

/** Routes each fetch call by matching the end of its URL, in the given order; records every URL seen. */
function routeFetch(routes: Array<[suffix: string, make: () => Response]>, calls: string[]): typeof globalThis.fetch {
  return (input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const hit = routes.find(([suffix]) => url.endsWith(suffix));
    if (!hit) return Promise.reject(new Error(`workday drift test: unexpected fetch ${url}`));
    return Promise.resolve(hit[1]());
  };
}

test("workday listPostings recovers from a stale site name: 404 -> robots.txt names one other site -> retry succeeds", async (t) => {
  const calls: string[] = [];
  stubFetch(
    t,
    routeFetch(
      [
        ["/wday/cxs/acme/External/jobs", () => new Response("not found", { status: 404 })],
        [
          "/robots.txt",
          () => new Response("User-agent: *\nAllow: /wday/\nAllow: /External2/\n", { status: 200 }),
        ],
        ["/wday/cxs/acme/External2/jobs", () => jsonResponse(driftListResponse("External2"))],
      ],
      calls,
    ),
  );

  const items = await workdayAdapter.listPostings(driftCompany);
  assert.equal(items.length, 1);
  assert.equal(at(items, 0).jobUrl, "https://acme.wd1.myworkdayjobs.com/en-US/External2/job/Pune/Engineer_R1");
  assert.deepEqual(calls, [
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs",
    "https://acme.wd1.myworkdayjobs.com/robots.txt",
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External2/jobs",
  ]);
});

test("workday listPostings recovers from an HTML-instead-of-JSON response the same way as a 404", async (t) => {
  const calls: string[] = [];
  stubFetch(
    t,
    routeFetch(
      [
        ["/wday/cxs/acme/External/jobs", () => htmlResponse("<!DOCTYPE html><html><body>gone</body></html>")],
        ["/robots.txt", () => new Response("Allow: /External2/\n", { status: 200 })],
        ["/wday/cxs/acme/External2/jobs", () => jsonResponse(driftListResponse("External2"))],
      ],
      calls,
    ),
  );

  const items = await workdayAdapter.listPostings(driftCompany);
  assert.equal(items.length, 1);
  assert.equal(calls.length, 3);
});

test("workday listPostings rethrows the original 404 when robots.txt lists multiple candidate sites", async (t) => {
  const calls: string[] = [];
  stubFetch(
    t,
    routeFetch(
      [
        ["/wday/cxs/acme/External/jobs", () => new Response("not found", { status: 404 })],
        ["/robots.txt", () => new Response("Allow: /External2/\nAllow: /External3/\n", { status: 200 })],
      ],
      calls,
    ),
  );

  await assert.rejects(workdayAdapter.listPostings(driftCompany), /workday 404/);
  assert.deepEqual(calls, [
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs",
    "https://acme.wd1.myworkdayjobs.com/robots.txt",
  ]);
});

test("workday listPostings rethrows the original 404 when robots.txt still lists the configured site (not drift)", async (t) => {
  const calls: string[] = [];
  stubFetch(
    t,
    routeFetch(
      [
        ["/wday/cxs/acme/External/jobs", () => new Response("not found", { status: 404 })],
        ["/robots.txt", () => new Response("Allow: /wday/\nAllow: /External/\n", { status: 200 })],
      ],
      calls,
    ),
  );

  await assert.rejects(workdayAdapter.listPostings(driftCompany), /workday 404/);
  assert.deepEqual(calls, [
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs",
    "https://acme.wd1.myworkdayjobs.com/robots.txt",
  ]);
});

test("workday listPostings never fetches robots.txt on a 429 (throttle, not drift)", async (t) => {
  // fetchOk itself retries a 429 (transient status) a few times before giving up - every one of those retries must still land on the listing URL, never robots.txt.
  const calls: string[] = [];
  stubFetch(
    t,
    routeFetch(
      [
        [
          "/wday/cxs/acme/External/jobs",
          () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
        ],
      ],
      calls,
    ),
  );

  await assert.rejects(workdayAdapter.listPostings(driftCompany), /HTTP 429/);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((u) => u.endsWith("/wday/cxs/acme/External/jobs")));
  assert.ok(!calls.some((u) => u.endsWith("/robots.txt")));
});
