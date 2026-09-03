import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAdityaBirla, adityaBirlaPageUrl } from "../adityabirla.js";
import type { AdityaBirlaJob } from "../adityabirla.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "adityabirla", slug: "ultratech-cement", name: "UltraTech Cement",
  careersUrl: "https://careers.adityabirla.com/job-search", tenantUrl: "https://careers.adityabirla.com",
  apiMeta: { orgunit: "Cement" },
};

// Trimmed from a live fetch of /api/v3/jobs?orgunit=Cement (2026-07-11).
const cementJob: AdityaBirlaJob = {
  id: "610461",
  organizationUnitComplete: "Cement>Cement>Cement>Cement>Secretarial",
  jobPostedDate: "2026-07-10T00:00:00.000Z",
  locationHierarchyComplete: "India>Maharashtra>Altimus Worli",
  jobDetailUrl: "",
  designation: "",
  organizationUnit: "Cement",
  jobTitle: "Lead Secretarial",
  locationHierarchy: "Maharashtra",
  jobDescription: "<h1>Job Purpose:</h1><p>Responsible for secretarial compliance.</p>",
};

test("adityaBirlaPageUrl builds an orgunit-filtered, page-numbered URL", () => {
  assert.equal(
    adityaBirlaPageUrl("Cement", 0),
    "https://careers.adityabirla.com/api/v3/jobs?orgunit=Cement&offset=0&limit=100",
  );
  assert.equal(
    adityaBirlaPageUrl("Financial Services", 3, 50),
    "https://careers.adityabirla.com/api/v3/jobs?orgunit=Financial%20Services&offset=3&limit=50",
  );
});

test("normalizeAdityaBirla maps fields, prefers jobTitle, strips HTML JD", () => {
  const p = normalizeAdityaBirla(company, cementJob);
  assert.equal(p.provider, "adityabirla");
  assert.equal(p.externalId, "610461");
  assert.equal(p.jobTitle, "Lead Secretarial");
  assert.equal(p.location, "India>Maharashtra>Altimus Worli");
  assert.match(p.jdText, /Responsible for secretarial compliance/);
  assert.doesNotMatch(p.jdText, /<h1>|<p>/);
  assert.equal(p.postedAt, new Date("2026-07-10T00:00:00.000Z").toISOString());
});

test("normalizeAdityaBirla falls back to locationHierarchy when the complete string is absent", () => {
  const p = normalizeAdityaBirla(company, { ...cementJob, locationHierarchyComplete: null });
  assert.equal(p.location, "Maharashtra");
});

test("normalizeAdityaBirla falls back to designation when jobTitle is blank", () => {
  const p = normalizeAdityaBirla(company, { ...cementJob, jobTitle: "", designation: "Secretarial Lead" });
  assert.equal(p.jobTitle, "Secretarial Lead");
});

test("normalizeAdityaBirla falls back to the shared job-search page when jobDetailUrl is empty", () => {
  const p = normalizeAdityaBirla(company, cementJob);
  assert.equal(p.jobUrl, "https://careers.adityabirla.com/job-search");
});

test("normalizeAdityaBirla uses jobDetailUrl when the API does provide one", () => {
  const p = normalizeAdityaBirla(company, { ...cementJob, jobDetailUrl: "https://careers.adityabirla.com/job/610461" });
  assert.equal(p.jobUrl, "https://careers.adityabirla.com/job/610461");
});

test("normalizeAdityaBirla flags isRemote from the location string", () => {
  const p = normalizeAdityaBirla(company, { ...cementJob, locationHierarchyComplete: "India>Remote" });
  assert.equal(p.isRemote, true);
});

test("normalizeAdityaBirla maps an unparseable postedDate to null", () => {
  const p = normalizeAdityaBirla(company, { ...cementJob, jobPostedDate: null });
  assert.equal(p.postedAt, null);
});
