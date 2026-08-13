// src/ats/__tests__/cvviz.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cvvizEmployerId, cvvizDisplaySlug, cvvizJobsUrl, cvvizLocation, normalizeCvviz, parseCvvizPage } from "../cvviz.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "cvviz",
  slug: "stackby",
  name: "Stackby",
  careersUrl: "https://jobs.cvviz.com/stackby",
  tenantUrl: "https://jobs.cvviz.com/stackby",
  apiMeta: { employerId: "1753" },
};

test("cvvizEmployerId reads the numeric careerpage id from api_meta, throwing when absent", () => {
  assert.equal(cvvizEmployerId(company), "1753");
  assert.throws(() => cvvizEmployerId({ ...company, apiMeta: null }), /employerId/);
});

test("cvvizDisplaySlug reads the last path segment of the tenant URL, else the registry slug", () => {
  assert.equal(cvvizDisplaySlug(company), "stackby");
  assert.equal(cvvizDisplaySlug({ ...company, tenantUrl: "https://jobs.cvviz.com/acme-corp/" }), "acme-corp");
  assert.equal(cvvizDisplaySlug({ ...company, tenantUrl: null, careersUrl: "https://jobs.cvviz.com/" }), "stackby");
});

test("cvvizJobsUrl builds the numeric-id paged jobs endpoint", () => {
  assert.equal(
    cvvizJobsUrl("1753", 2, 25),
    "https://jobs.cvviz.com/api/career/employers/1753/jobs?page=2&pageSize=25",
  );
});

test("cvvizLocation joins city, state, country; skips blanks; null when all empty", () => {
  assert.equal(cvvizLocation({ city: "Surat", state: "Gujarat", country: "India" }), "Surat, Gujarat, India");
  assert.equal(cvvizLocation({ city: "Bengaluru", state: null, country: "India" }), "Bengaluru, India");
  assert.equal(cvvizLocation({ city: null, state: null, country: null }), null);
});

const rawJob = {
  id: "52374",
  title: "Inside Sales Executive",
  country: "India",
  city: "Surat",
  state: "Gujarat",
  jobdescription: "<div><strong>Description</strong>: Manage leads.</div>",
};

test("normalizeCvviz maps id/title/location/JD (JD inline, no detail fetch)", () => {
  const p = normalizeCvviz(company, rawJob);
  assert.equal(p.provider, "cvviz");
  assert.equal(p.externalId, "52374");
  assert.equal(p.jobTitle, "Inside Sales Executive");
  assert.equal(p.location, "Surat, Gujarat, India");
  assert.equal(p.jobUrl, "https://jobs.cvviz.com/stackby/job/52374");
  assert.match(p.jdText, /Manage leads\./);
  assert.doesNotMatch(p.jdText, /<div>/);
});

test("parseCvvizPage validates the {data,total} envelope and maps rows", () => {
  const page = parseCvvizPage(company, asJson({ data: [rawJob, { ...rawJob, id: "52375" }], total: 2 }));
  assert.equal(page.total, 2);
  assert.equal(page.postings.length, 2);
  assert.deepEqual(page.postings.map((p) => p.externalId), ["52374", "52375"]);
});

test("parseCvvizPage tolerates a missing total (returns null) and an empty page", () => {
  const page = parseCvvizPage(company, asJson({ data: [] }));
  assert.equal(page.total, null);
  assert.equal(page.postings.length, 0);
});

test("parseCvvizPage throws on a wrong-shaped envelope (field drift)", () => {
  assert.throws(() => parseCvvizPage(company, asJson({ jobs: [] })), /schema/i);
});
