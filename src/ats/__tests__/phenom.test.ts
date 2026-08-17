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
  phenomTenantHasLocale,
  phenomWidgetsUrl,
  phenomWidgetsBody,
  phenomAdapter,
} from "../phenom.js";
import type { AdapterCompany } from "../../types.js";

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
  // The teaser is NOT inlined; fetchJd pulls the full JD from the job page.
  assert.equal(p.jdText, "");
});

test("normalizePhenom builds the canonical job page when applyUrl is absent or empty", () => {
  // A widgets response can carry applyUrl: ""; the old `applyUrl ?? tenantUrl` fallback used to link those to the search-results page.
  const noApply = PhenomJobSchema.parse({ jobId: "P-183145", title: "Cluster Manager" });
  assert.equal(
    normalizePhenom(company, noApply).jobUrl,
    "https://www.jobs.abbott/us/en/job/P-183145",
  );

  const emptyApply = PhenomJobSchema.parse({ jobId: "P-183807", title: "Banker", applyUrl: "" });
  assert.equal(
    normalizePhenom(company, emptyApply).jobUrl,
    "https://www.jobs.abbott/us/en/job/P-183807",
  );
});

test("normalizePhenom falls back to careersUrl only when tenantUrl is missing", () => {
  const noTenant = { ...company, tenantUrl: null };
  const j = PhenomJobSchema.parse({ jobId: "P-1", title: "Role" });
  assert.equal(normalizePhenom(noTenant, j).jobUrl, company.careersUrl);
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

test("phenomTenantHasLocale requires the two-segment locale prefix", () => {
  assert.ok(phenomTenantHasLocale("https://careers.godrejindustries.com/in/en/search-results"));
  assert.ok(phenomTenantHasLocale("https://www.jobs.abbott/us/en/search-results?qcountry=India"));
  assert.ok(phenomTenantHasLocale("https://careers.abb/global/en/search-results"));
  // Invalid: a bare host or a host with only one path segment; phenomJobPageUrl would emit a locale-less URL with no jobDetail ddo.
  assert.equal(phenomTenantHasLocale("https://careers.godrejindustries.com"), false);
  assert.equal(phenomTenantHasLocale("https://careers.godrejindustries.com/"), false);
  assert.equal(phenomTenantHasLocale("https://careers.godrejindustries.com/in"), false);
});

test("listPostings rejects a locale-less tenant_url before fetching anything", async () => {
  const company: AdapterCompany = {
    provider: "phenom",
    slug: "godrej-agrovet",
    name: "Godrej Agrovet",
    careersUrl: "https://careers.godrejindustries.com",
    tenantUrl: "https://careers.godrejindustries.com",
    apiMeta: null,
  };
  await assert.rejects(
    () => phenomAdapter.listPostings(company),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    (err: unknown) => {
      const msg = String(err);
      // One actionable config error, not a board full of JD failures.
      assert.match(msg, /missing the \/<country>\/<lang> locale segment/);
      assert.match(msg, /godrej-agrovet/);
      return true;
    },
  );
});

test("phenomWidgetsUrl targets the tenant origin regardless of locale path", () => {
  assert.equal(
    phenomWidgetsUrl("https://careers.dhl.com/global/en/search-results"),
    "https://careers.dhl.com/widgets",
  );
  assert.equal(
    phenomWidgetsUrl("https://careers.merckgroup.com/global/en/search-results?from=0"),
    "https://careers.merckgroup.com/widgets",
  );
});

test("phenomWidgetsBody paginates and filters to India server-side", () => {
  const body = phenomWidgetsBody(100, 50);
  assert.equal(body["from"], 100);
  assert.equal(body["size"], 50);
  assert.equal(body["ddoKey"], "refineSearch");
  // The India facet is the whole point: DHL is 8027 jobs globally, 337 in India.
  assert.deepEqual(body["selected_fields"], { country: ["India"] });
});

test("phenomJobsFrom reads the widget XHR response shape, not just the eager ddo", () => {
  // Live shape from careers.dhl.com/widgets: {refineSearch:{totalHits, data:{jobs}}}
  const widgetResponse = {
    refineSearch: {
      status: 200,
      totalHits: 337,
      data: { jobs: [{ jobId: "AV-1", title: "Architect", cityStateCountry: "INDORE, India" }] },
    },
  };
  const { jobs, totalHits } = phenomJobsFrom(widgetResponse);
  assert.equal(totalHits, 337);
  assert.equal(jobs.length, 1);
  // and the same parser still handles the server-rendered eager shape
  const eager = { eagerLoadRefineSearch: { totalHits: 5, data: { jobs: [{ jobId: "x", title: "T" }] } } };
  assert.equal(phenomJobsFrom(eager).totalHits, 5);
});
