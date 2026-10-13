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
import { fetchSequence, htmlResponse, jsonResponse, stubFetch } from "./testHelpers.js";
import { rejectionOf } from "../../__tests__/caught.js";

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
  assert.equal(p.jdText, "");
});

test("normalizePhenom builds the canonical job page when applyUrl is absent or empty", () => {
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
    (err) => {
      const msg = String(err);
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
  assert.deepEqual(body["selected_fields"], { country: ["India"] });
});

test("phenomJobsFrom reads the widget XHR response shape, not just the eager ddo", () => {
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
  const eager = { eagerLoadRefineSearch: { totalHits: 5, data: { jobs: [{ jobId: "x", title: "T" }] } } };
  assert.equal(phenomJobsFrom(eager).totalHits, 5);
});

test("phenomJobDescriptionFrom returns empty for a live job published with no description", () => {
  const blank = extractPhenomDdo(`<script>phApp.ddo = {"jobDetail":{"status":200,"hits":1,"data":{"job":{"jobId":"P-230420","title":"Banker","description":""}}}};</script>`);
  assert.equal(phenomJobDescriptionFrom(blank), "");
  const missing = extractPhenomDdo(`<script>phApp.ddo = {"jobDetail":{"status":200,"hits":1,"data":{"job":{"jobId":"P-104278","title":"GET"}}}};</script>`);
  assert.equal(phenomJobDescriptionFrom(missing), "");
  const notFound = extractPhenomDdo(`<script>phApp.ddo = {"jobDetail":{"status":200,"hits":0,"totalHits":0,"data":{}}};</script>`);
  assert.equal(phenomJobDescriptionFrom(notFound), null);
});

const idfc: AdapterCompany = {
  provider: "phenom", slug: "idfcfirst", name: "IDFC FIRST Bank",
  careersUrl: "https://careers.idfcfirst.bank.in/in/en/search-results",
  tenantUrl: "https://careers.idfcfirst.bank.in/in/en/search-results", apiMeta: null,
};
const idfcPosting = {
  provider: "phenom" as const, externalId: "P-230420", companySlug: "idfcfirst", companyName: "IDFC FIRST Bank",
  jobTitle: "Banker-Customer Experience", jobUrl: "https://careers.idfcfirst.bank.in/in/en/job/P-230420",
  location: "Jaipur, Rajasthan, India", isRemote: false, jdText: "", postedAt: null,
};

test("fetchJd returns an empty JD (stored as no-jd, rechecked weekly) when the job is published without one", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(
    `<script>phApp.ddo = {"jobDetail":{"status":200,"hits":1,"data":{"job":{"jobId":"P-230420","description":""}}}}; phApp.sessionParams = {"a":1}; /*--&gt;*/</script>`,
  )));
  assert.ok(phenomAdapter.fetchJd);
  assert.equal(await phenomAdapter.fetchJd(idfc, idfcPosting), "");
});

test("fetchJd still extracts a populated description", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(
    `<script>phApp.ddo = {"jobDetail":{"status":200,"hits":1,"data":{"job":{"jobId":"P-224718","description":"<p>Job <b>Purpose</b></p>"}}}};</script>`,
  )));
  assert.ok(phenomAdapter.fetchJd);
  assert.match(await phenomAdapter.fetchJd(idfc, { ...idfcPosting, externalId: "P-224718" }), /Job Purpose/);
});

test("fetchJd names a job missing from jobDetail as not found rather than a missing description", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(
    `<script>phApp.ddo = {"jobDetail":{"status":200,"hits":0,"totalHits":0,"data":{}}};</script>`,
  )));
  assert.ok(phenomAdapter.fetchJd);
  const err = await rejectionOf(phenomAdapter.fetchJd(idfc, idfcPosting));
  assert.match(String(err), /job P-230420 not found in jobDetail/);
});

test("fetchJd reports a page with no ddo island as a template problem", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse("<html><body>maintenance</body></html>")));
  assert.ok(phenomAdapter.fetchJd);
  const err = await rejectionOf(phenomAdapter.fetchJd(idfc, idfcPosting));
  assert.match(String(err), /no phApp\.ddo island/);
});

test("listPostings fails loudly when a large board has zero India jobs instead of yielding an empty board", async (t) => {
  // talent.lowes.com/us/en is the US store board; India lives on /in/en.
  const lowes: AdapterCompany = {
    provider: "phenom", slug: "lowes", name: "Lowe's India",
    careersUrl: "https://talent.lowes.com/us/en/search-results",
    tenantUrl: "https://talent.lowes.com/us/en/search-results", apiMeta: null,
  };
  const usJob = { jobId: "JR-1", title: "Sales Associate", cityStateCountry: "Kahului, HI, United States" };
  stubFetch(t, fetchSequence(
    () => htmlResponse(`<script>phApp.ddo = {"eagerLoadRefineSearch":{"totalHits":4442,"data":{"jobs":[${JSON.stringify(usJob)}]}}};</script>`),
    () => jsonResponse({ refineSearch: { totalHits: 0, data: { jobs: [] } } }),
    () => jsonResponse({ refineSearch: { totalHits: 4442, data: { jobs: [usJob] } } }),
  ));
  const err = await rejectionOf(phenomAdapter.listPostings(lowes));
  assert.match(String(err), /lowes board lists 4442 jobs but none tagged India/);
});
