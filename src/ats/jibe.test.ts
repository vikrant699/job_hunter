// src/ats/jibe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { jibeApiUrl, jibePageJobs, normalizeJibe } from "./jibe.js";
import type { JibeJob } from "./jibe.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "jibe", slug: "schneider-pw", name: "Schneider Electric India",
  careersUrl: "https://careers.se.com/jobs", tenantUrl: "https://careers.se.com",
  apiMeta: { location: "India" },
};

const job: JibeJob = {
  slug: "117559",
  req_id: "117559",
  title: "Senior Software Engineer I - React Native",
  description: "<p>Build mobile experiences.</p><ul><li>React Native</li></ul>",
  full_location: "Bangalore, India",
  short_location: "Bangalore, India",
  location_name: "Bangalore",
  country: "India",
  location_type: "onsite",
  posted_date: "July 1, 2026",
  meta_data: { canonical_url: "https://careers.se.com/jobs/117559?lang=en-us" },
};

test("jibeApiUrl builds the paged search URL from the tenant origin with the apiMeta location filter", () => {
  assert.equal(jibeApiUrl(company, 3), "https://careers.se.com/api/jobs?page=3&location=India");
});

test("jibeApiUrl falls back to the careers URL origin and omits the filter without apiMeta.location", () => {
  const c: AdapterCompany = { ...company, tenantUrl: null, apiMeta: null };
  assert.equal(jibeApiUrl(c, 1), "https://careers.se.com/api/jobs?page=1");
});

test("jibePageJobs unwraps the jobs[].data envelope and totalCount", () => {
  const page = { jobs: [{ data: job }], totalCount: 497, count: 10 };
  const r = jibePageJobs(page);
  assert.equal(r.totalCount, 497);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0]?.title, "Senior Software Engineer I - React Native");
});

test("normalizeJibe maps fields: canonical URL, location precedence, html-stripped JD, ISO date", () => {
  const p = normalizeJibe(company, job);
  assert.equal(p.provider, "jibe");
  assert.equal(p.externalId, "117559");
  assert.equal(p.jobTitle, "Senior Software Engineer I - React Native");
  assert.equal(p.jobUrl, "https://careers.se.com/jobs/117559?lang=en-us");
  assert.equal(p.location, "Bangalore, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /React Native/);
  assert.doesNotMatch(p.jdText, /<p>|<li>/);
  assert.equal(p.postedAt, new Date("July 1, 2026").toISOString());
});

test("normalizeJibe synthesizes the job URL from slug when meta_data has no canonical_url", () => {
  const p = normalizeJibe(company, { ...job, meta_data: null });
  assert.equal(p.jobUrl, "https://careers.se.com/jobs/117559");
});

test("normalizeJibe: remote location_type sets isRemote, unparseable date maps to null", () => {
  const p = normalizeJibe(company, { ...job, location_type: "remote", posted_date: "recently" });
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, null);
});
