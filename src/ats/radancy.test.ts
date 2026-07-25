// src/ats/radancy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  radancyListUrl,
  parseRadancyTotals,
  parseRadancyJobId,
  parseRadancyList,
  parseRadancyJd,
} from "./radancy.js";
import type { AdapterCompany } from "../types.js";

const fordCompany: AdapterCompany = {
  provider: "radancy",
  slug: "ford",
  name: "Ford Motor Company",
  careersUrl: "https://www.careers.ford.com/location/chennai-tamil-nadu-india-jobs/48560/1269750-1255053-1264527/4",
  tenantUrl: null,
  apiMeta: null,
};

const intuitCompany: AdapterCompany = {
  provider: "radancy",
  slug: "intuit",
  name: "Intuit",
  careersUrl: "https://jobs.intuit.com/search-jobs",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed real markup from GET on the Ford Chennai location landing —
// captured live. Two rows from the actual `#search-results` results list,
// plus one row from Ford's separate same-page "similar jobs" widget
// (`.job-list__list`) that must NOT be picked up (it holds unrelated
// non-India jobs and lacks "search-results" in its container id/class).
const FORD_LIST_HTML = `
<html><body>
    <section id="search-results" class="search-results" data-total-results="15" data-total-pages="1" data-records-per-page="15">
        <ul id="search-results-jobs" class="search-results-list__list" data-results-count="15">
            <li class="search-results-list__item">
                <div class="search-results-list__content">
                    <h2 class="search-results-list__job-title">
                        <a class="search-results-list__job-link" href="/job/chennai/technical-product-manager/48560/95551928096" data-job-id="95551928096">Technical Product Manager</a>
                    </h2>
                    <ul class="search-results-list__job-info-list">
                        <li class="search-results-list__job-info job-location">
                            Chennai, India
                        </li>
                    </ul>
                </div>
            </li>
            <li class="search-results-list__item">
                <div class="search-results-list__content">
                    <h2 class="search-results-list__job-title">
                        <a class="search-results-list__job-link" href="/job/chennai/data-engineer/48560/97602976592" data-job-id="97602976592">Data Engineer</a>
                    </h2>
                    <ul class="search-results-list__job-info-list">
                        <li class="search-results-list__job-info job-location">
                            Chennai, India
                        </li>
                    </ul>
                </div>
            </li>
        </ul>
    </section>

    <ul class="job-list__list" data-save-jobs="true">
        <li class="job-list__item">
            <div class="job-list__content">
                <h3 class="job-list__job-title">
                    <a class="job-list__job-link" href="/job/palo-alto/contract-recruiter/48560/97634112848" data-job-id="97634112848">
                        Contract Recruiter
                    </a>
                </h3>
                <ul class="job-list__job-info-list">
                    <li class="job-list__job-info job-location">Palo Alto, California</li>
                </ul>
            </div>
        </li>
    </ul>
</body></html>
`;

// Trimmed real markup from GET jobs.intuit.com/search-jobs — captured live.
// Intuit's location is a <span> INSIDE the anchor (unlike Ford's, which is a
// sibling outside it), proving the "subtract location text from the
// anchor's text" title rule.
const INTUIT_LIST_HTML = `
<html><body>
    <section id="search-results" class="search-results" data-total-results="357" data-total-pages="24" data-records-per-page="15">
    </section>
    <section id="search-results-list" class="search-results-list-wrapper">
        <ul class="search-list">
            <li data-remote="21443" data-count="0">
                <a href="/job/frisco/senior-manager-partner-customer-success/27595/93463860592" data-job-id="21443" class="sr-item">
                    <h2>Senior Manager, Partner Customer Success</h2>
                    <span class="job-location">Multiple Locations</span>
                </a>
            </li>
            <li data-remote="21444" data-count="0">
                <a href="/job/bengaluru/backend-engineer-remote/27595/93513716176" data-job-id="21444" class="sr-item">
                    <h2>Backend Engineer (Remote)</h2>
                    <span class="job-location">Remote - India</span>
                </a>
            </li>
        </ul>
    </section>
</body></html>
`;

const FORD_JD_HTML = `
<html><body>
    <section class="job-description" data-org-id="48560" data-job-id="95551928096">
        <h1 class="job-description__heading">Technical Product Manager</h1>
        <dl class="job-description__desc-list">
            <div class="job-description__desc-job-info job-job-id">
                <dt class="job-description__desc-term job-term-job-id">Job ID</dt>
                <dd class="job-description__desc-detail job-detail-job-id">63838</dd>
            </div>
        </dl>
        <div class="ats-description">
            <p><span>This position requires strong hybrid technical project management experience with GCP software development background.</span></p>
            <p><strong>Primary Skills Required:</strong></p>
            <ul><li>15+ years of IT product/program delivery experience</li></ul>
        </div>
    </section>

    <div class="content-page-display">
        <p class="content-page-display__description">
            <span>Built on one bold idea and the passion to define sustainable transportation for generations to come.</span>
        </p>
    </div>
</body></html>
`;

const INTUIT_JD_HTML = `
<html><body>
    <section id="job-detail-pull" class="job-description pane pane-jd" data-org-id="27595" data-job-id="93463860592">
        <div class="section9-content">
            <h1>Senior Manager, Partner Customer Success</h1>
            <div class="job-description__job-info">
                <span class="job-category-jd job-info"><b>Category</b> Customer Success</span>
            </div>
            <p>Come join Intuit's Customer Success organization and help small businesses thrive with our TurboTax and QuickBooks products.</p>
            <p>You will partner with cross-functional teams to design and deliver a world-class post-sale experience.</p>
        </div>
    </section>
</body></html>
`;

test("radancyListUrl leaves page 1 unchanged and appends ?p=N / &p=N depending on an existing query string", () => {
  assert.equal(radancyListUrl(intuitCompany.careersUrl, 1), intuitCompany.careersUrl);
  assert.equal(radancyListUrl(intuitCompany.careersUrl, 2), "https://jobs.intuit.com/search-jobs?p=2");
  assert.equal(
    radancyListUrl("https://jobs.intuit.com/search-jobs?location=India", 3),
    "https://jobs.intuit.com/search-jobs?location=India&p=3",
  );
  // Location-scoped landing base (Ford) — no hardcoded /search-jobs path.
  assert.equal(radancyListUrl(fordCompany.careersUrl, 2), `${fordCompany.careersUrl}?p=2`);
});

test("parseRadancyTotals reads data-total-pages / data-total-results, or null when absent", () => {
  assert.deepEqual(parseRadancyTotals(FORD_LIST_HTML), { totalPages: 1, totalResults: 15 });
  assert.deepEqual(parseRadancyTotals(INTUIT_LIST_HTML), { totalPages: 24, totalResults: 357 });
  assert.deepEqual(parseRadancyTotals("<html></html>"), { totalPages: null, totalResults: null });
});

test("parseRadancyJobId extracts the trailing numeric jobId segment", () => {
  assert.equal(
    parseRadancyJobId("/job/chennai/technical-product-manager/48560/95551928096"),
    "95551928096",
  );
  assert.equal(
    parseRadancyJobId("/job/frisco/senior-manager-partner-customer-success/27595/93463860592?src=x"),
    "93463860592",
  );
  assert.equal(parseRadancyJobId("/job/chennai/no-id-here/"), null);
});

test("parseRadancyList (Ford): scopes to the real search-results container, excludes the same-page similar-jobs widget", () => {
  const postings = parseRadancyList(FORD_LIST_HTML, fordCompany);
  assert.equal(postings.length, 2);

  const [tpm, de] = postings;
  assert.equal(tpm?.provider, "radancy");
  assert.equal(tpm?.externalId, "95551928096");
  assert.equal(tpm?.jobTitle, "Technical Product Manager");
  assert.equal(
    tpm?.jobUrl,
    "https://www.careers.ford.com/job/chennai/technical-product-manager/48560/95551928096",
  );
  assert.equal(tpm?.location, "Chennai, India");
  assert.equal(tpm?.isRemote, false);
  assert.equal(tpm?.jdText, "");
  assert.equal(tpm?.postedAt, null);

  assert.equal(de?.externalId, "97602976592");
  assert.equal(de?.jobTitle, "Data Engineer");

  // The .job-list__list widget's "Contract Recruiter" (Palo Alto) must not appear.
  assert.ok(!postings.some((p) => p.externalId === "97634112848"));
  assert.ok(!postings.some((p) => p.jobTitle === "Contract Recruiter"));
});

test("parseRadancyList (Intuit): subtracts the in-anchor location span from the title, detects remote", () => {
  const postings = parseRadancyList(INTUIT_LIST_HTML, intuitCompany);
  assert.equal(postings.length, 2);

  const [sm, be] = postings;
  assert.equal(sm?.externalId, "93463860592");
  assert.equal(sm?.jobTitle, "Senior Manager, Partner Customer Success");
  assert.equal(
    sm?.jobUrl,
    "https://jobs.intuit.com/job/frisco/senior-manager-partner-customer-success/27595/93463860592",
  );
  assert.equal(sm?.location, "Multiple Locations");
  assert.equal(sm?.isRemote, false);

  assert.equal(be?.jobTitle, "Backend Engineer (Remote)");
  assert.equal(be?.location, "Remote - India");
  assert.equal(be?.isRemote, true);
});

test("parseRadancyList dedups by externalId and returns [] when there's no search-results container", () => {
  const dup = `
    <section id="search-results">
      <ul class="search-list">
        <li><a href="/job/x/role/1/111"><h2>Role</h2></a></li>
      </ul>
    </section>
    <section class="search-results-list-wrapper">
      <ul><li><a href="/job/x/role/1/111"><h2>Role</h2></a></li></ul>
    </section>`;
  assert.equal(parseRadancyList(dup, intuitCompany).length, 1);
  assert.deepEqual(parseRadancyList("<html><body>No jobs.</body></html>", fordCompany), []);
});

test("parseRadancyList skips a /job/ anchor with no numeric id and one with no title", () => {
  const malformed = `
    <section id="search-results">
      <ul>
        <li><a href="/job/no-id-here/"><h2>Bad Id</h2></a></li>
        <li><a href="/job/x/role/1/222"></a></li>
      </ul>
    </section>`;
  assert.deepEqual(parseRadancyList(malformed, fordCompany), []);
});

test("parseRadancyJd (Ford): picks the real .ats-description body, not the unrelated content-page-display__description marketing blurb", () => {
  const jd = parseRadancyJd(FORD_JD_HTML);
  assert.match(jd, /hybrid technical project management/);
  assert.match(jd, /Primary Skills Required/);
  assert.doesNotMatch(jd, /Built on one bold idea/);
  assert.doesNotMatch(jd, /<p>|<div>/);
});

test("parseRadancyJd (Intuit): falls back to the job-description tier when ats-description is absent", () => {
  const jd = parseRadancyJd(INTUIT_JD_HTML);
  assert.match(jd, /Customer Success organization/);
  assert.match(jd, /world-class post-sale experience/);
});

test("parseRadancyJd returns '' when no known JD class tier matches (malformed/changed page)", () => {
  assert.equal(parseRadancyJd("<html><body>Not found</body></html>"), "");
});

test("parseRadancyList (ARM): reads location from a bare span.location when job-location is absent", () => {
  const armHtml = `<html><body><section id="search-results" data-total-results="1" data-total-pages="1">
    <ul><li>
      <a href="/job/bangalore/senior-cpu-engineer/33099/98765432101">
        <h2>Senior CPU Engineer</h2>
        <span class="location">Bangalore, India</span>
      </a>
    </li></ul>
  </section></body></html>`;
  const postings = parseRadancyList(armHtml, {
    provider: "radancy",
    slug: "arm",
    name: "ARM India",
    careersUrl: "https://careers.arm.com/search-jobs/India",
    tenantUrl: null,
    apiMeta: null,
  });
  assert.equal(postings.length, 1);
  assert.equal(postings[0]!.jobTitle, "Senior CPU Engineer");
  assert.equal(postings[0]!.location, "Bangalore, India");
});
