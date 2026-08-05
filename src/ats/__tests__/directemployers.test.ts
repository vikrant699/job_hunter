// src/ats/directemployers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { directemployersAdapter, normalizeDeJob } from "../directemployers.js";
import type { DeJob } from "../directemployers.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, jsonResponse, mkAdapterCompany } from "./test-helpers.js";

const company: AdapterCompany = mkAdapterCompany(
  { provider: "directemployers", slug: "deere", name: "John Deere", careersUrl: "https://deerecareers.jobs/" },
  { apiMeta: { origin: "deerecareers.jobs" } },
);

const job: DeJob = {
  id: 123,
  guid: "guid-123",
  reqid: "req-123",
  title_exact: "Software Engineer",
  location_exact: "Bengaluru, Karnataka, India",
  city_exact: null,
  country_exact: null,
  description: "Build tractors' software.",
  url: "https://deerecareers.jobs/job/123",
};

// --- normalizeDeJob: externalId fallback chain -----------------------------

test("externalId prefers guid when present", () => {
  assert.equal(normalizeDeJob(company, job)?.externalId, "guid-123");
});

test("externalId falls back to id when guid is absent", () => {
  assert.equal(normalizeDeJob(company, { ...job, guid: null })?.externalId, "123");
});

test("externalId falls back to reqid when guid and id are both absent", () => {
  assert.equal(normalizeDeJob(company, { ...job, guid: null, id: null })?.externalId, "req-123");
});

test("externalId falls back to the title when guid/id/reqid are all absent", () => {
  assert.equal(normalizeDeJob(company, { ...job, guid: null, id: null, reqid: null })?.externalId, "Software Engineer");
});

// --- normalizeDeJob: Task-16 location contract -----------------------------

test("location_exact wins over the city/country join when present", () => {
  assert.equal(normalizeDeJob(company, job)?.location, "Bengaluru, Karnataka, India");
});

test("falls back to 'City, Country' when location_exact is absent", () => {
  const p = normalizeDeJob(company, { ...job, location_exact: null, city_exact: "Pune", country_exact: "India" });
  assert.equal(p?.location, "Pune, India");
});

test("city-only (no country) falls back to just the city", () => {
  const p = normalizeDeJob(company, { ...job, location_exact: null, city_exact: "Pune", country_exact: null });
  assert.equal(p?.location, "Pune");
});

test("no location_exact/city/country maps location to null", () => {
  const p = normalizeDeJob(company, { ...job, location_exact: null, city_exact: null, country_exact: null });
  assert.equal(p?.location, null);
  assert.equal(p.isRemote, false);
});

// --- listPostings: x-origin header + pagination ----------------------------

test("listPostings sends x-origin from apiMeta.origin", async (t) => {
  let originHeader: string | null = null;
  stubFetch(t, async (_input, init) => {
    originHeader = new Headers(init?.headers).get("x-origin");
    return jsonResponse({ jobs: [], pagination: { total_pages: 1 } });
  });
  await directemployersAdapter.listPostings(company);
  assert.equal(originHeader, "deerecareers.jobs");
});

test("falls back to the careersUrl host for x-origin when apiMeta.origin is absent", async (t) => {
  const c = mkAdapterCompany({
    provider: "directemployers",
    slug: "deere",
    name: "John Deere",
    careersUrl: "https://deerecareers.jobs/careers",
  });
  let originHeader: string | null = null;
  stubFetch(t, async (_input, init) => {
    originHeader = new Headers(init?.headers).get("x-origin");
    return jsonResponse({ jobs: [], pagination: { total_pages: 1 } });
  });
  await directemployersAdapter.listPostings(c);
  assert.equal(originHeader, "deerecareers.jobs");
});

test("paginates via pagination.total_pages, accumulating jobs across both pages", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        jobs: [
          { id: 1, title_exact: "Job One" },
          { id: 2, title_exact: "Job Two" },
        ],
        pagination: { total_pages: 2 },
      });
    }
    return jsonResponse({
      jobs: [{ id: 3, title_exact: "Job Three" }],
      pagination: { total_pages: 2 },
    });
  });
  const postings = await directemployersAdapter.listPostings(company);
  assert.deepEqual(postings.map((p) => p.externalId), ["1", "2", "3"]);
  assert.equal(calls, 2, "must stop once total_pages is reached -- no third page fetched");
});
