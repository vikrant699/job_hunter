// src/ats/amazonjobs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { amazonJobsApiUrl, amazonJobsPageJobs, normalizeAmazonJobs } from "../amazonjobs.js";
import type { AmazonJob } from "../amazonjobs.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "amazonjobs", slug: "amazon", name: "Amazon",
  careersUrl: "https://www.amazon.jobs/en/search?country=IND", tenantUrl: null,
  apiMeta: { country: "IND" },
};

const job: AmazonJob = {
  id_icims: "10471212",
  title: "ML Data Associate-II, Artificial General Intelligence",
  location: "IN, TS, Hyderabad",
  city: "Hyderabad",
  country_code: "IND",
  job_path: "/en/jobs/10471212/ml-data-associate-ii-artificial-general-intelligence",
  posted_date: "July 10, 2026",
  description: "<p>Build the future of human-technology interaction.</p><br/>Key job responsibilities<br/>Own the roadmap.",
  description_short: "Build the future of human-technology interaction.",
};

const virtualJob: AmazonJob = {
  id_icims: "10555001",
  title: "GSS - Tech Sourcing Recruiter, WWAS TA C Sourcing",
  location: "IN, KA, Bangalore - Virtual",
  city: "Bangalore",
  country_code: "IND",
  job_path: "/en/jobs/10555001/gss-tech-sourcing-recruiter",
  posted_date: "July 9, 2026",
  description: null,
  description_short: "Source candidates across AWS teams.",
};

test("amazonJobsApiUrl builds the paged search URL with apiMeta.country", () => {
  assert.equal(
    amazonJobsApiUrl(company, 200),
    "https://www.amazon.jobs/en/search.json?country=IND&result_limit=100&offset=200&sort=recent",
  );
});

test("amazonJobsApiUrl defaults country to IND without apiMeta", () => {
  const c: AdapterCompany = { ...company, apiMeta: null };
  assert.equal(
    amazonJobsApiUrl(c, 0),
    "https://www.amazon.jobs/en/search.json?country=IND&result_limit=100&offset=0&sort=recent",
  );
});

test("amazonJobsPageJobs parses the jobs array and surfaces hits as total", () => {
  const page = { hits: 2680, jobs: [job, virtualJob], facets: {}, content: null };
  const r = amazonJobsPageJobs(page);
  assert.equal(r.total, 2680);
  assert.equal(r.jobs.length, 2);
  assert.equal(r.jobs[0]?.title, job.title);
});

test("amazonJobsPageJobs: pagination-stop arithmetic — a page reaching hits ends the loop", () => {
  // A page whose offset + returned jobs meets/exceeds hits is the last page;
  // paginate() (src/ats/shared.ts) uses this exact `total` to decide that.
  const lastPage = amazonJobsPageJobs({ hits: 2, jobs: [job, virtualJob] });
  assert.equal(0 + lastPage.jobs.length >= (lastPage.total ?? 0), true);

  const midPage = amazonJobsPageJobs({ hits: 5, jobs: [job, virtualJob] });
  assert.equal(0 + midPage.jobs.length >= (midPage.total ?? 0), false);
});

test("amazonJobsPageJobs tolerates a missing hits field", () => {
  const r = amazonJobsPageJobs({ jobs: [job] });
  assert.equal(r.total, null);
  assert.equal(r.jobs.length, 1);
});

test("normalizeAmazonJobs maps fields: full location string, absolute job URL, html-stripped JD, ISO date", () => {
  const p = normalizeAmazonJobs(company, job);
  assert.equal(p.provider, "amazonjobs");
  assert.equal(p.externalId, "10471212");
  assert.equal(p.jobTitle, "ML Data Associate-II, Artificial General Intelligence");
  assert.equal(
    p.jobUrl,
    "https://www.amazon.jobs/en/jobs/10471212/ml-data-associate-ii-artificial-general-intelligence",
  );
  assert.equal(p.location, "IN, TS, Hyderabad");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Key job responsibilities/);
  assert.doesNotMatch(p.jdText, /<p>|<br\/?>/);
  assert.equal(p.postedAt, new Date("July 10, 2026").toISOString());
});

test("normalizeAmazonJobs falls back to description_short when description is null", () => {
  const p = normalizeAmazonJobs(company, virtualJob);
  assert.equal(p.jdText, "Source candidates across AWS teams.");
});

test('normalizeAmazonJobs: "- Virtual" in location sets isRemote true', () => {
  const p = normalizeAmazonJobs(company, virtualJob);
  assert.equal(p.location, "IN, KA, Bangalore - Virtual");
  assert.equal(p.isRemote, true);
});

test("normalizeAmazonJobs falls back to city/country_code when location is null", () => {
  const p = normalizeAmazonJobs(company, { ...job, location: null });
  assert.equal(p.location, "Hyderabad, IND");
});

test("normalizeAmazonJobs: unparseable posted_date maps to null", () => {
  const p = normalizeAmazonJobs(company, { ...job, posted_date: "recently" });
  assert.equal(p.postedAt, null);
});

test("normalizeAmazonJobs: missing posted_date maps to null", () => {
  const p = normalizeAmazonJobs(company, { ...job, posted_date: null });
  assert.equal(p.postedAt, null);
});
