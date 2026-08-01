import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsiderJobSchema, normalizeConsider, considerJobsFrom, considerSearchBody } from "./consider.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "consider", slug: "meragi", name: "Meragi",
  careersUrl: "https://jobs.surgeahead.com/jobs",
  tenantUrl: "https://jobs.surgeahead.com/jobs",
  apiMeta: { boardId: "meragi" },
};

const RESPONSE = {
  total: 23,
  jobs: [{
    jobId: "abc-123", title: "Wedding Sales Manager",
    locations: ["Jaipur, RJ, India"], companyName: "Meragi", companySlug: "meragi",
    url: "https://jobs.surgeahead.com/companies/meragi/jobs/abc-123",
    applyUrl: "https://meragi.example/apply/abc-123",
    minYearsExp: 2, maxYearsExp: 5, remote: false,
  }],
};

test("considerSearchBody targets one company, not the parent board", () => {
  const body = considerSearchBody("meragi", 100, 0);
  assert.deepEqual(body["board"], { id: "meragi", isParent: false });
  assert.deepEqual(body["meta"], { size: 100, offset: 0 });
});

test("considerJobsFrom reads jobs + total", () => {
  const { jobs, total } = considerJobsFrom(RESPONSE);
  assert.equal(total, 23);
  assert.equal(jobs.length, 1);
});

test("normalizeConsider maps a record to NormalizedPosting", () => {
  const { jobs } = considerJobsFrom(RESPONSE);
  const p = normalizeConsider(company, ConsiderJobSchema.parse(jobs[0]));
  assert.equal(p.provider, "consider");
  assert.equal(p.externalId, "abc-123");
  assert.equal(p.jobTitle, "Wedding Sales Manager");
  assert.equal(p.location, "Jaipur, RJ, India");
  assert.equal(p.jobUrl, "https://jobs.surgeahead.com/companies/meragi/jobs/abc-123");
  assert.equal(p.isRemote, false);
});

test("normalizeConsider joins multiple locations and detects remote", () => {
  const p = normalizeConsider(company, ConsiderJobSchema.parse({
    jobId: "x", title: "SRE", locations: ["Bangalore", "Remote"], remote: true,
    url: "https://jobs.surgeahead.com/j/x",
  }));
  assert.equal(p.location, "Bangalore, Remote");
  assert.equal(p.isRemote, true);
});

test("ConsiderJobSchema rejects a record with no id", () => {
  assert.equal(ConsiderJobSchema.safeParse({ title: "No id" }).success, false);
});
