// src/ats/sfunify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sfunifyRequestBody,
  sfunifyPageJobs,
  normalizeSfunify,
  sfunifyLocation,
  parseSfunifyStartDate,
  sfunifyJobUrl,
  extractSfunifyJd,
  SfunifyJobSchema,
} from "./sfunify.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "sfunify", slug: "skyworks", name: "Skyworks Solutions India",
  careersUrl: "https://careers.skyworksinc.com/search/?q=&locationsearch=",
  tenantUrl: "https://careers.skyworksinc.com", apiMeta: null,
};

const scbCompany: AdapterCompany = {
  ...company, slug: "standard-chartered", name: "Standard Chartered GCC",
  tenantUrl: "https://jobs.standardchartered.com",
  apiMeta: { locale: "en_GB", location: "India" },
};

// HCLTech's tenant ignores the flat `location` field entirely (returns 0
// results for ANY non-empty value, confirmed live) but honors the same
// country facet under `facetFilters.custCountryRegion`.
const hclCompany: AdapterCompany = {
  ...company, slug: "hcltech", name: "HCLTech",
  tenantUrl: "https://careers.hcltech.com",
  apiMeta: { location: "India", locationFacetField: "custCountryRegion" },
};

// Trimmed real response shape captured live from
// POST https://careers.skyworksinc.com/services/recruiting/v1/jobs
const listFixture = {
  jobSearchResult: [
    {
      response: {
        id: "76824",
        unifiedStandardTitle: "Principal Programmer / Analyst 2",
        urlTitle: "Principal-Programmer-Analyst-2",
        unifiedUrlTitle: "Principal-Programmer-Analyst-2",
        jobLocationShort: ["Bangalore, KA, IND    "],
        unifiedStandardStart: "7/9/26",
      },
    },
    {
      response: {
        // id arrives as a JSON number on at least one tenant — schema must coerce.
        id: 77184,
        unifiedStandardTitle: "Sr. Buyer 2　(Strategic Sourcing Specialist)",
        // already percent-encoded by the API — must NOT be re-encoded downstream.
        urlTitle: "Sr_-Buyer-2%E3%80%80%28Strategic-Sourcing-Specialist%29",
        unifiedUrlTitle: "Sr_-Buyer-2%E3%80%80%28Strategic-Sourcing-Specialist%29",
        jobLocationShort: ["Suminoe-ku, 27, JPN    "],
        unifiedStandardStart: "3/11/26",
      },
    },
  ],
  totalJobs: 62,
};

test("sfunifyRequestBody defaults to locale en_US and an unfiltered location", () => {
  const body = sfunifyRequestBody(company, 0);
  assert.equal(body["locale"], "en_US");
  assert.equal(body["pageNumber"], 0);
  assert.equal(body["location"], "");
});

test("sfunifyRequestBody honors apiMeta.locale + apiMeta.location overrides (Standard Chartered)", () => {
  const body = sfunifyRequestBody(scbCompany, 3);
  assert.equal(body["locale"], "en_GB");
  assert.equal(body["pageNumber"], 3);
  assert.equal(body["location"], "India");
  assert.deepEqual(body["facetFilters"], {});
});

test("sfunifyRequestBody routes the filter through facetFilters when apiMeta.locationFacetField is set (HCLTech)", () => {
  const body = sfunifyRequestBody(hclCompany, 0);
  assert.equal(body["location"], ""); // flat field left empty — HCLTech ignores it
  assert.deepEqual(body["facetFilters"], { custCountryRegion: ["India"] });
});

test("sfunifyPageJobs unwraps jobSearchResult[].response + totalJobs", () => {
  const { jobs, totalJobs } = sfunifyPageJobs(listFixture);
  assert.equal(totalJobs, 62);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.id, "76824");
  assert.equal(jobs[1]?.id, "77184"); // coerced from number to string
});

test("sfunifyPageJobs tolerates a missing jobSearchResult / totalJobs", () => {
  const { jobs, totalJobs } = sfunifyPageJobs({});
  assert.deepEqual(jobs, []);
  assert.equal(totalJobs, null);
});

test("SfunifyJobSchema requires id + unifiedStandardTitle only", () => {
  const parsed = SfunifyJobSchema.parse({ id: "1", unifiedStandardTitle: "X" });
  assert.equal(parsed.id, "1");
});

test("parseSfunifyStartDate reads M/D/YY (2-digit year, en_US-style tenants)", () => {
  assert.equal(parseSfunifyStartDate("7/9/26"), new Date(Date.UTC(2026, 6, 9)).toISOString());
});

test("parseSfunifyStartDate reads DD/MM/YYYY (4-digit year, Standard Chartered's en_GB)", () => {
  assert.equal(parseSfunifyStartDate("29/06/2026"), new Date(Date.UTC(2026, 5, 29)).toISOString());
});

test("parseSfunifyStartDate returns null for missing/unparseable input", () => {
  assert.equal(parseSfunifyStartDate(null), null);
  assert.equal(parseSfunifyStartDate(undefined), null);
  assert.equal(parseSfunifyStartDate("recently"), null);
});

test("sfunifyJobUrl interpolates the API's pre-encoded urlTitle as-is (no double-encoding)", () => {
  const job = SfunifyJobSchema.parse(at(listFixture.jobSearchResult, 1).response);
  assert.equal(
    sfunifyJobUrl(company, job, "en_US"),
    "https://careers.skyworksinc.com/job/Sr_-Buyer-2%E3%80%80%28Strategic-Sourcing-Specialist%29/77184-en_US",
  );
});

test("normalizeSfunify maps fields: trims location, builds job url, ISO postedAt", () => {
  const job = SfunifyJobSchema.parse(at(listFixture.jobSearchResult, 0).response);
  const p = normalizeSfunify(company, job, "en_US");
  assert.equal(p.provider, "sfunify");
  assert.equal(p.externalId, "76824");
  assert.equal(p.jobTitle, "Principal Programmer / Analyst 2");
  assert.equal(p.jobUrl, "https://careers.skyworksinc.com/job/Principal-Programmer-Analyst-2/76824-en_US");
  assert.equal(p.location, "Bangalore, KA, IND");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, new Date(Date.UTC(2026, 6, 9)).toISOString());
});

test("normalizeSfunify strips a stray embedded HTML tag from the location (seen live on Wipro)", () => {
  const job = SfunifyJobSchema.parse({
    id: "142130", unifiedStandardTitle: "Techno Functional Consultant L1",
    jobLocationShort: ["Tampa, USA-FL, USA, 33634<br/>"],
  });
  const p = normalizeSfunify(company, job, "en_US");
  assert.equal(p.location, "Tampa, USA-FL, USA, 33634");
});

test("normalizeSfunify falls back to null location when jobLocationShort is absent", () => {
  const job = SfunifyJobSchema.parse({ id: "1", unifiedStandardTitle: "X" });
  const p = normalizeSfunify(company, job, "en_US");
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

// HCLTech's tenant has no jobLocationShort field at all — location lives in
// separate custom fields (custprimecity + custCountryRegion) instead.
test("sfunifyLocation falls back to custprimecity + custCountryRegion when jobLocationShort is absent (HCLTech)", () => {
  const job = SfunifyJobSchema.parse({
    id: "54163", unifiedStandardTitle: "Analyst",
    custprimecity: "Mumbai", custCountryRegion: ["India"],
  });
  assert.equal(sfunifyLocation(job), "Mumbai, India");
});

test("sfunifyLocation uses custCountryRegion alone when custprimecity is absent", () => {
  const job = SfunifyJobSchema.parse({
    id: "11929", unifiedStandardTitle: "Consultant", custCountryRegion: ["India"],
  });
  assert.equal(sfunifyLocation(job), "India");
});

test("sfunifyLocation prefers jobLocationShort over the custom fields when both are present", () => {
  const job = SfunifyJobSchema.parse({
    id: "1", unifiedStandardTitle: "X",
    jobLocationShort: ["Bangalore, KA, IND    "],
    custprimecity: "Paris", custCountryRegion: ["France"],
  });
  assert.equal(sfunifyLocation(job), "Bangalore, KA, IND");
});

// Trimmed real HTML captured live from
// https://careers.wipro.com/job/IT-Project-Manager-2/77719-en_US style detail pages
// (SF Unify renders the JD server-side inside one or more
// <span itemprop="description">...</span> blocks — intro boilerplate, the
// actual "Job Description:" section, and sometimes a closing EEO statement).
const jdHtml = `
<div class="joblayouttoken">
  <div class="inner">
    <div class="row"><div class="col-xs-12 fontalign-left">
    <span xml:lang="en-US" lang="en-US" itemprop="description" class="rtltextaligneligible"><p>If you are looking for a challenging and exciting career in the world of technology, then look no further. Skyworks is an innovator of high performance analog semiconductors whose solutions are powering the wireless networking revolution. At Skyworks, you will find a fast-paced environment with a strong focus on global collaboration.</p>
<p>Req ID: 77719 </p>
    </span>
    </div></div>
  </div>
</div>
<div class="joblayouttoken">
  <div class="inner">
    <div class="row"><div class="col-xs-12 fontalign-left">
    <span class="joblayouttoken-label" role="heading" aria-level="2">Job Description: </span>
    <span xml:lang="en-US" lang="en-US" itemprop="description" class="rtltextaligneligible"><div><div><H2><b>Description</b></H2></div><div><p>The Project Manager will be responsible for managing Information Technology projects from initiation to completion. The ideal candidate should have 2 to 5 years of experience in project management, specifically in IT, and possess Project Management education or certifications.</p></div></div><div><H2><b>Responsibilities</b></H2><ul type="circle">
<li>Adheres to Skyworks's Project Lifecycle Management methodology for all projects.</li>
<li>Plan, execute, and close IT projects, ensuring they are completed on time, within scope, and within budget.</li>
<li>Manage scope, schedule, and resource allocation.</li>
<li>Identify and manage project risks, issues, and dependencies.</li>
<li>Lead and motivate project teams, ensuring clear communication and collaboration.</li>
</ul></div>
    </span>
    </div></div>
  </div>
</div>
<div class="joblayouttoken">
  <div class="row"><div class="col-xs-12 fontalign-left">
    <span xml:lang="en-US" lang="en-US" itemprop="description" class="rtltextaligneligible"><p>Skyworks is proud to be an equal opportunity employer supporting diversity in the workplace.</p>
    </span>
  </div></div>
</div>
`;

test("extractSfunifyJd concatenates every itemprop=description span, strips HTML, and clears 500 chars", () => {
  const text = extractSfunifyJd(jdHtml);
  assert.ok(text.length > 500, `expected >500 chars, got ${text.length}`);
  assert.match(text, /Project Manager will be responsible/);
  assert.match(text, /equal opportunity employer/);
  assert.doesNotMatch(text, /<p>|<li>|<div>/);
});

test("extractSfunifyJd returns empty string when no description span is present", () => {
  assert.equal(extractSfunifyJd("<html><body>nothing here</body></html>"), "");
});

// Real shape seen live on Standard Chartered postings: an inline
// <span style="font-family:..."> nested INSIDE the itemprop=description
// span for text-run styling. A naive non-greedy match against the next
// </span> stops at the inner tag and truncates the JD — regression guard.
const nestedSpanHtml = `
<span itemprop="description" class="rtltextaligneligible"><div><div style="padding:10px"><h2><b>Job Summary</b></h2></div><div><p><span style="font-family:arial, helvetica, sans-serif;font-size:10pt">Achieve NTB target for the region and drive portfolio growth across the assigned book of clients, ensuring adherence to compliance and risk policies while building long-term relationships with key stakeholders across the business.</span></p>
<p><span style="font-family:arial, helvetica, sans-serif;font-size:10pt">Partner with product and credit teams to structure financing solutions, coordinate onboarding, and monitor portfolio health on an ongoing basis throughout the relationship lifecycle.</span></p></div></div></span>
<span itemprop="description" class="rtltextaligneligible"><p>Standard Chartered is an equal opportunity employer.</p></span>
`;

test("extractSfunifyJd does not truncate at a nested <span style=...> inside the description block", () => {
  const text = extractSfunifyJd(nestedSpanHtml);
  assert.match(text, /Achieve NTB target for the region/);
  assert.match(text, /Partner with product and credit teams/);
  assert.match(text, /equal opportunity employer/);
  assert.doesNotMatch(text, /<span|<p>|<div>/);
});
