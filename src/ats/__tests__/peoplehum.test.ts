// src/ats/peoplehum.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { peoplehumListUrl, peoplehumJobs, isPeoplehumPrivate, normalizePeoplehum } from "../peoplehum.js";
import type { PeoplehumJob } from "../peoplehum.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "peoplehum", slug: "16900", name: "Devnagri",
  careersUrl: "https://hire.peoplehum.com/devnagri", tenantUrl: null, apiMeta: null,
};

// Captured live 2026-07-11 from
// https://webapi.peoplehum.com/api/web/internal-api/customer/16900/external/job/list
const job: PeoplehumJob = {
  id: "4ff664c2-1d81-4cf3-b89c-bf6ba34e317b",
  title: "Voicebot Developer",
  description: "POSITION: Voicebot Developer: Real-Time Streaming AI\nJob Type: Work From Office (5 days)\n",
  descriptionHTML: "<p><strong>POSITION: Voicebot Developer: Real-Time Streaming AI</strong></p><p>Job Type: Work From Office (5 days)</p>",
  employmentType: "PH_FULL_TIME",
  experience: "2+",
  isPrivate: 0,
  isRemote: false,
  location: [{ countryCity: "Noida, India", id: 6018, zipcode: "201301" }],
  requestedDate: 1773081000000,
  workPlaceType: "ONSITE",
};

const rawEnvelope = {
  responseObject: {
    content: [job, { ...job, id: "96aec9c3-8721-4051-bb13-a929fec6dfec", title: "Language Specialist" }],
    functions: [{ id: 10633, name: "Engineering" }],
    locations: [{ countryCity: "Noida, India", id: 6018, zipcode: "201301" }],
    workPlaceTypes: [{ displayKey: "PH_ONSITE", key: "ONSITE" }],
  },
  status: { code: 1000, desc: "SUCCESS" },
};

test("peoplehumListUrl builds the customerId-scoped list URL", () => {
  assert.equal(
    peoplehumListUrl(company),
    "https://webapi.peoplehum.com/api/web/internal-api/customer/16900/external/job/list",
  );
});

test("peoplehumJobs unwraps responseObject.content, tolerating extra envelope keys", () => {
  const jobs = peoplehumJobs(rawEnvelope);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.title, "Voicebot Developer");
  assert.equal(jobs[1]?.title, "Language Specialist");
});

test("isPeoplehumPrivate treats numeric 0/1 and booleans as truthy/falsy", () => {
  assert.equal(isPeoplehumPrivate(job), false);
  assert.equal(isPeoplehumPrivate({ ...job, isPrivate: 1 }), true);
  assert.equal(isPeoplehumPrivate({ ...job, isPrivate: true }), true);
  assert.equal(isPeoplehumPrivate({ ...job, isPrivate: null }), false);
});

test("normalizePeoplehum maps fields: html-stripped JD, joined location, epoch-ms postedAt", () => {
  const p = normalizePeoplehum(company, job);
  assert.equal(p.provider, "peoplehum");
  assert.equal(p.externalId, "4ff664c2-1d81-4cf3-b89c-bf6ba34e317b");
  assert.equal(p.jobTitle, "Voicebot Developer");
  assert.equal(p.jobUrl, "https://hire.peoplehum.com/devnagri");
  assert.equal(p.location, "Noida, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Real-Time Streaming AI/);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
  assert.equal(p.postedAt, new Date(1773081000000).toISOString());
});

test("normalizePeoplehum prefers descriptionHTML but falls back to plain description", () => {
  const p = normalizePeoplehum(company, { ...job, descriptionHTML: null });
  assert.match(p.jdText, /Real-Time Streaming AI/);
});

test("normalizePeoplehum: isRemote true when isRemote flag or workPlaceType says so", () => {
  const p1 = normalizePeoplehum(company, { ...job, isRemote: true });
  assert.equal(p1.isRemote, true);
  const p2 = normalizePeoplehum(company, { ...job, isRemote: false, workPlaceType: "REMOTE" });
  assert.equal(p2.isRemote, true);
});

test("normalizePeoplehum: missing location array maps to null", () => {
  const p = normalizePeoplehum(company, { ...job, location: null });
  assert.equal(p.location, null);
});

test("normalizePeoplehum: missing requestedDate maps postedAt to null", () => {
  const p = normalizePeoplehum(company, { ...job, requestedDate: null });
  assert.equal(p.postedAt, null);
});
