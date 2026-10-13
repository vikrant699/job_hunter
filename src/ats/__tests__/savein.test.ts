import { test } from "node:test";
import assert from "node:assert/strict";
import { saveinAdapter } from "../savein.js";
import type { AdapterCompany } from "../../types.js";
import { rejectionOf } from "../../__tests__/caught.js";
import { at, fetchSequence, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "savein", slug: "savein", name: "SaveIN", careersUrl: "https://savein.money/careers",
});

function job(id: number, overrides: object = {}) {
  return {
    id,
    createdAt: "2025-01-23T09:54:09.000+00:00",
    updatedAt: "2026-03-30T08:36:45.000+00:00",
    departmentId: 4,
    dateOfPosting: "2025-01-23T09:54:09.000+00:00",
    title: "Key Account Manager ",
    type: "FULL_TIME",
    location: "Gurgaon",
    experienceRequired: "0-3",
    status: "ACTIVE",
    aboutTheCompany: "<p>SaveIN is embedded healthcare finance.</p>",
    aboutTheRole: "<p>Manage key accounts.</p>",
    keyResponsibilities: "<p>Grow partnerships</p>",
    skillsRequired: "<p>Communication</p>",
    ...overrides,
  };
}

test("listPostings normalizes the one-shot list with the JD sections inline", async (t) => {
  const urls: string[] = [];
  const seq = fetchSequence(() => jsonResponse({ response: [job(13), job(15, { location: "Blr,Del,Kol" })], success: true, message: "ok" }));
  stubFetch(t, (input, init) => {
    urls.push(String(input));
    return seq(input, init);
  });
  const postings = await saveinAdapter.listPostings(company);
  assert.deepEqual(urls, ["https://cms.api.savein.money/web/careers/list"]);
  assert.equal(postings.length, 2);
  const p = at(postings, 0);
  assert.equal(p.provider, "savein");
  assert.equal(p.externalId, "13");
  assert.equal(p.jobTitle, "Key Account Manager");
  assert.equal(p.jobUrl, "https://savein.money/career/job-details/13");
  assert.equal(p.location, "Gurgaon, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, "2025-01-23T09:54:09.000+00:00");
  assert.match(p.jdText, /Manage key accounts\.[\s\S]*Grow partnerships[\s\S]*Communication/);
  assert.doesNotMatch(p.jdText, /<p>/);
  assert.equal(at(postings, 1).location, "Blr,Del,Kol, India");
});

test("listPostings drops non-ACTIVE openings", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ response: [job(1), job(2, { status: "INACTIVE" })], success: true })));
  const postings = await saveinAdapter.listPostings(company);
  assert.deepEqual(postings.map((p) => p.externalId), ["1"]);
});

test("listPostings rejects a body with no response array", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ success: false, message: "nope" })));
  assert.match(String(await rejectionOf(saveinAdapter.listPostings(company))), /schema/);
});
