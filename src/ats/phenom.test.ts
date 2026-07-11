// src/ats/phenom.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPhenomDdo,
  phenomJobsFrom,
  normalizePhenom,
  PhenomJobSchema,
  phenomJobPageUrl,
  phenomJobDescriptionFrom,
} from "./phenom.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "phenom", slug: "abbott", name: "Abbott India",
  careersUrl: "https://www.jobs.abbott/us/en/search-results",
  tenantUrl: "https://www.jobs.abbott/us/en/search-results", apiMeta: null,
};

const html = `<script>phApp.ddo = {"eagerLoadRefineSearch":{"totalHits":244,"data":{"jobs":[
  {"jobId":31146766,"reqId":31146766,"title":"Business Development Manager","cityStateCountry":"Mumbai, Maharashtra, India","postedDate":"2026-05-30","type":"Full time","descriptionTeaser":"Responsible for <b>all</b> business development.","applyUrl":"https://www.jobs.abbott/us/en/job/31146766/x"}
]}}};</script>`;

test("extractPhenomDdo parses the island and phenomJobsFrom reads jobs+total", () => {
  const ddo = extractPhenomDdo(html);
  assert.ok(ddo, "ddo parsed");
  const { jobs, totalHits } = phenomJobsFrom(ddo);
  assert.equal(totalHits, 244);
  assert.equal(jobs.length, 1);
});

test("extractPhenomDdo returns null when absent", () => {
  assert.equal(extractPhenomDdo("<html>no island</html>"), null);
});

test("normalizePhenom maps fields", () => {
  const { jobs } = phenomJobsFrom(extractPhenomDdo(html));
  const p = normalizePhenom(company, PhenomJobSchema.parse(jobs[0]));
  assert.equal(p.provider, "phenom");
  assert.equal(p.externalId, "31146766");
  assert.equal(p.jobTitle, "Business Development Manager");
  assert.equal(p.location, "Mumbai, Maharashtra, India");
  assert.equal(p.jobUrl, "https://www.jobs.abbott/us/en/job/31146766/x");
  // The teaser is NOT inlined — fetchJd pulls the full JD from the job page.
  assert.equal(p.jdText, "");
});

test("phenomJobPageUrl derives origin + locale prefix from the tenant search URL", () => {
  assert.equal(
    phenomJobPageUrl("https://www.jobs.abbott/us/en/search-results?qcountry=India", "31146766"),
    "https://www.jobs.abbott/us/en/job/31146766",
  );
  assert.equal(
    phenomJobPageUrl("https://careers.abb/global/en/search-results", "JR-02586427"),
    "https://careers.abb/global/en/job/JR-02586427",
  );
});

test("phenomJobDescriptionFrom reads jobDetail.data.job.description", () => {
  const jobHtml = `<script>phApp.ddo = {"jobDetail":{"data":{"job":{"description":"<p>Full <b>JD</b> body</p>"}}}};</script>`;
  const ddo = extractPhenomDdo(jobHtml);
  assert.equal(phenomJobDescriptionFrom(ddo), "<p>Full <b>JD</b> body</p>");
  assert.equal(phenomJobDescriptionFrom(extractPhenomDdo(html)), null);
});
