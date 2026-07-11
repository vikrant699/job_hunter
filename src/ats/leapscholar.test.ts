// src/ats/leapscholar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { leapscholarJobs, normalizeLeapscholar } from "./leapscholar.js";
import type { LeapscholarJob } from "./leapscholar.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "leapscholar", slug: "leapscholar", name: "Leap Scholar",
  careersUrl: "https://careers.leapfinance.com", tenantUrl: null, apiMeta: null,
};

// Captured live 2026-07-11 from https://careers-api-eight.vercel.app/api/jobs
const job: LeapscholarJob = {
  JobId: "21afc854-ff00-45d2-9700-169a262bba6d",
  JobTitle: "SDE -II",
  JobDescription: "<p>We are looking for a Backend / Full Stack Engineer.</p><p>Own product features end-to-end.</p>",
  Department: "Engineering",
  Location: '[{"Address":"Bengaluru, Karnataka, India","PlaceId":null}]',
  JobType: "Full Time",
  ApplyUrl: "https://app.turbohire.co/job/publicjobs/21afc854-ff00-45d2-9700-169a262bba6d?utm_source=CareerPage",
  PublishedDate: "2026-06-30T15:19:18.3936756Z",
  CreatedDate: "2026-06-30T10:15:20.9824547",
};

const remoteJob: LeapscholarJob = {
  JobId: "b3574852-b6b7-444e-ab9f-32a73f1cdc3e",
  JobTitle: "IELTS Demo Trainer",
  JobDescription: "<p>We're disrupting IELTS education in India.</p>",
  Department: "IELTS - Trainer",
  Location: '[{"Address":"Bengaluru, Karnataka, India","PlaceId":null}]',
  JobType: "Part Time Consultant",
  ApplyUrl: "https://app.turbohire.co/job/publicjobs/b3574852-b6b7-444e-ab9f-32a73f1cdc3e?utm_source=CareerPage",
  PublishedDate: "2026-06-30T10:11:54.7998139Z",
  CreatedDate: "2026-06-30T09:51:33.3452073",
};

test("leapscholarJobs unwraps {Total, Jobs} when they agree", () => {
  const jobs = leapscholarJobs({ Total: 2, Jobs: [job, remoteJob] });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.JobTitle, "SDE -II");
});

test("leapscholarJobs still returns Jobs when Total disagrees with Jobs.length (warns, doesn't throw)", () => {
  const jobs = leapscholarJobs({ Total: 99, Jobs: [job] });
  assert.equal(jobs.length, 1);
});

test("normalizeLeapscholar maps fields: ApplyUrl as jobUrl, html-stripped JD, parsed Location", () => {
  const p = normalizeLeapscholar(company, job);
  assert.equal(p.provider, "leapscholar");
  assert.equal(p.externalId, "21afc854-ff00-45d2-9700-169a262bba6d");
  assert.equal(p.jobTitle, "SDE -II");
  assert.equal(p.jobUrl, "https://app.turbohire.co/job/publicjobs/21afc854-ff00-45d2-9700-169a262bba6d?utm_source=CareerPage");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Backend \/ Full Stack Engineer/);
  assert.doesNotMatch(p.jdText, /<p>/);
  assert.equal(p.postedAt, "2026-06-30T15:19:18.3936756Z");
});

test("normalizeLeapscholar falls back to careersUrl when ApplyUrl is missing", () => {
  const p = normalizeLeapscholar(company, { ...job, ApplyUrl: null });
  assert.equal(p.jobUrl, "https://careers.leapfinance.com");
});

test("normalizeLeapscholar falls back to CreatedDate when PublishedDate is missing", () => {
  const p = normalizeLeapscholar(company, { ...job, PublishedDate: null });
  assert.equal(p.postedAt, "2026-06-30T10:15:20.9824547");
});

test("normalizeLeapscholar: malformed Location JSON maps to null instead of throwing", () => {
  const p = normalizeLeapscholar(company, { ...job, Location: "not json" });
  assert.equal(p.location, null);
});

test("normalizeLeapscholar: isRemote true when JobType says remote/WFH-flavored text", () => {
  const p = normalizeLeapscholar(company, { ...job, JobType: "Remote" });
  assert.equal(p.isRemote, true);
});

test("normalizeLeapscholar handles the second captured job (part-time, HSR location)", () => {
  const p = normalizeLeapscholar(company, remoteJob);
  assert.equal(p.jobTitle, "IELTS Demo Trainer");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
});
