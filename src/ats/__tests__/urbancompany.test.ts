// src/ats/urbancompany.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrbancompany, urbancompanyAdapter } from "../urbancompany.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "urbancompany", slug: "urbancompany", name: "Urban Company",
  careersUrl: "https://careers.urbancompany.com", tenantUrl: null, apiMeta: null,
};

// Trimmed live fixture — captured 2026-07-11 from
// POST https://www.urbanclap.com/api/v2/platform-gateway/getAllJobs (body {})
const job = {
  job_id: "8a31200e-1ab3-4f68-a59f-2037732da59c",
  job_code: "UCL-8888",
  parent_department: "Business",
  location: ["Kochi, Kerala, India"],
  location_city: ["Kochi"],
  job_title: "Senior Manager - Kochi",
  job_description: "<p><strong>About Urban Company</strong></p><p>Urban Company is a technology platform.</p>",
  apply_url: "https://urbancompany.turbohire.co/job/publicjobs/8a31200e-1ab3-4f68-a59f-2037732da59c?utm_source=CareerPage",
};

const multiLocationJob = {
  job_id: "1f0e547e-2978-4913-affe-e27154a1a812",
  job_code: "UTIPL-18528",
  parent_department: "Business",
  location: ["Delhi, India", "Gurugram, Haryana, India", "Noida, Uttar Pradesh, India"],
  location_city: ["Delhi", "Gurugram", "Noida"],
  job_title: "Category Manager - Central",
  job_description: "<p>Own category strategy across NCR.</p>",
  apply_url: "https://urbancompany.turbohire.co/job/publicjobs/1f0e547e-2978-4913-affe-e27154a1a812?utm_source=CareerPage",
};

const noApplyUrlJob = {
  job_id: "no-url-job",
  job_code: null,
  parent_department: null,
  location: [],
  location_city: [],
  job_title: "Untitled Role",
  job_description: null,
  apply_url: null,
};

test("normalizeUrbancompany maps a single-location posting", () => {
  const p = normalizeUrbancompany(company, job);
  assert.equal(p.provider, "urbancompany");
  assert.equal(p.externalId, "8a31200e-1ab3-4f68-a59f-2037732da59c");
  assert.equal(p.jobTitle, "Senior Manager - Kochi");
  assert.equal(p.jobUrl, job.apply_url);
  assert.equal(p.location, "Kochi, Kerala, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /About Urban Company/);
  assert.match(p.jdText, /technology platform/);
  assert.equal(p.postedAt, null);
});

test("normalizeUrbancompany joins multi-city location arrays", () => {
  const p = normalizeUrbancompany(company, multiLocationJob);
  assert.equal(p.location, "Delhi, India; Gurugram, Haryana, India; Noida, Uttar Pradesh, India");
});

test("normalizeUrbancompany falls back to the careers page when apply_url is absent", () => {
  const p = normalizeUrbancompany(company, noApplyUrlJob);
  assert.equal(p.jobUrl, "https://careers.urbancompany.com");
  assert.equal(p.location, null);
  assert.equal(p.jdText, "");
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("urbancompanyAdapter.listPostings POSTs an empty JSON body and maps every job", async () => {
  let capturedInit: RequestInit | undefined;
  stubFetch(async (input, init) => {
    capturedInit = init;
    assert.equal(String(input), "https://www.urbanclap.com/api/v2/platform-gateway/getAllJobs");
    return Response.json({ jobs: [job, multiLocationJob] });
  });
  try {
    const postings = await urbancompanyAdapter.listPostings(company);
    assert.equal(postings.length, 2);
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit.body, "{}");
    assert.equal(new Headers(capturedInit.headers).get("Content-Type"), "application/json");
  } finally {
    restoreFetch();
  }
});
