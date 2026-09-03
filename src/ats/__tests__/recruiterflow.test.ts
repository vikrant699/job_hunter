import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recruiterflowSlug,
  recruiterflowListUrl,
  recruiterflowJobUrl,
  parseRecruiterflowJobsList,
  parseRecruiterflowJd,
  normalizeRecruiterflow,
  recruiterflowAdapter,
} from "../recruiterflow.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "recruiterflow",
  slug: "coinswitch",
  name: "CoinSwitch",
  careersUrl: "https://recruiterflow.com/coinswitch/jobs",
  tenantUrl: "https://recruiterflow.com/coinswitch/jobs",
  apiMeta: null,
};

// Two dept groups with a duplicate job_id (only "department" should surface) and a semicolon in a job name to exercise the balanced-brace scan.
const LIST_HTML = `<!doctype html><html><body>
  <div id="rf-jobs-list"></div>
  <script src="/static/js/manual/careers/careers.js?v=0.11"></script>
  <script type="text/javascript">
    window.jobsList = {"department": [["Brand", [{"apply_link": "coinswitch/jobs/692", "details": "Bengaluru", "employment_type": "Full time", "job_id": 692, "job_name": "Senior Associate - Brand; Growth", "last_opened": "2026-06-09T06:46:35+0000", "remote_type": null}]], ["P&L - Indian Equity", [{"apply_link": "coinswitch/jobs/676", "details": "Remote", "employment_type": "Full time", "job_id": 676, "job_name": "Relationship Manager (B2B AP)", "last_opened": "2026-04-30T09:49:17+0000", "remote_type": "Remote"}]]], "group": [["Brand", [{"apply_link": "coinswitch/jobs/692", "details": "Bengaluru", "employment_type": "Full time", "job_id": 692, "job_name": "Senior Associate - Brand; Growth", "last_opened": "2026-06-09T06:46:35+0000", "remote_type": null}]]], "location": [["Bengaluru", [{"apply_link": "coinswitch/jobs/692", "details": "Brand", "employment_type": "Full time", "job_id": 692, "job_name": "Senior Associate - Brand; Growth", "last_opened": "2026-06-09T06:46:35+0000", "remote_type": null}]], ["Remote", [{"apply_link": "coinswitch/jobs/676", "details": "P&L - Indian Equity", "employment_type": "Full time", "job_id": 676, "job_name": "Relationship Manager (B2B AP)", "last_opened": "2026-04-30T09:49:17+0000", "remote_type": "Remote"}]]]};
    window.viewOpportunitiesBtnColor = "#0A58FF";
  </script>
</body></html>`;

// Trimmed real markup shape from GET https://recruiterflow.com/coinswitch/jobs/692
const JD_HTML = `<!doctype html><html><head>
  <script type="application/ld+json">{"@context": "http://schema.org/", "@type": "JobPosting", "title": "Senior Associate - Brand", "description": "<div>Know the company.</div><p>Lead our brand campaigns across India.</p>", "identifier": {"@type": "PropertyValue", "name": "CoinSwitch", "value": "db_x__692"}, "datePosted": "2026-06-09", "employmentType": "FULL_TIME"}</script>
</head><body></body></html>`;

test("recruiterflowSlug derives the path segment from tenantUrl, falling back to careersUrl", () => {
  assert.equal(recruiterflowSlug(company), "coinswitch");
  assert.equal(
    recruiterflowSlug({ ...company, tenantUrl: null, careersUrl: "https://recruiterflow.com/instamojo/jobs" }),
    "instamojo",
  );
  // Lokal's opaque slug
  assert.equal(
    recruiterflowSlug({ ...company, tenantUrl: "https://recruiterflow.com/db_fdae8243f06575ca46a3063600388f33/jobs" }),
    "db_fdae8243f06575ca46a3063600388f33",
  );
});

test("recruiterflowSlug throws on a URL with no path segment", () => {
  assert.throws(() => recruiterflowSlug({ ...company, tenantUrl: "https://recruiterflow.com/" }));
});

test("recruiterflowListUrl / recruiterflowJobUrl build the documented endpoints", () => {
  assert.equal(recruiterflowListUrl(company), "https://recruiterflow.com/coinswitch/jobs");
  assert.equal(recruiterflowJobUrl("coinswitch", 692), "https://recruiterflow.com/coinswitch/jobs/692");
});

test("parseRecruiterflowJobsList flattens the department grouping and dedups by job_id (balanced-brace scan handles ';' inside job names)", () => {
  const stubs = parseRecruiterflowJobsList(LIST_HTML);
  assert.equal(stubs.length, 2);
  assert.deepEqual(
    stubs.map((s) => s.job_id).sort(),
    [676, 692],
  );
  const brand = stubs.find((s) => s.job_id === 692);
  assert.equal(brand?.job_name, "Senior Associate - Brand; Growth");
  assert.equal(brand.details, "Bengaluru");
});

test("parseRecruiterflowJobsList returns [] when window.jobsList is absent (empty board / layout change)", () => {
  assert.deepEqual(parseRecruiterflowJobsList("<html><body>No jobs right now.</body></html>"), []);
});

test("parseRecruiterflowJobsList throws when the marker is present but the payload isn't valid JSON", () => {
  assert.throws(() =>
    parseRecruiterflowJobsList('<script>window.jobsList = {"department": [oops};</script>'),
  );
});

test("parseRecruiterflowJd extracts the JD text from the JobPosting ld+json description", () => {
  const jd = parseRecruiterflowJd(JD_HTML);
  assert.match(jd, /Know the company/);
  assert.match(jd, /Lead our brand campaigns across India/);
  assert.doesNotMatch(jd, /<div>|<p>/);
});

test("parseRecruiterflowJd returns '' when the ld+json block is absent or malformed", () => {
  assert.equal(parseRecruiterflowJd("<html><body>Not found</body></html>"), "");
  assert.equal(
    parseRecruiterflowJd('<script type="application/ld+json">{not json}</script>'),
    "",
  );
});

test("normalizeRecruiterflow maps fields and flags remote via remote_type or REMOTE_RE", () => {
  const stubs = parseRecruiterflowJobsList(LIST_HTML);
  const brand = stubs.find((s) => s.job_id === 692);
  const remote = stubs.find((s) => s.job_id === 676);
  assert(brand);
  assert(remote);

  const p1 = normalizeRecruiterflow(company, "coinswitch", brand);
  assert.equal(p1.provider, "recruiterflow");
  assert.equal(p1.externalId, "692");
  assert.equal(p1.jobTitle, "Senior Associate - Brand; Growth");
  assert.equal(p1.jobUrl, "https://recruiterflow.com/coinswitch/jobs/692");
  assert.equal(p1.location, "Bengaluru");
  assert.equal(p1.isRemote, false);
  assert.equal(p1.jdText, "");
  assert.equal(p1.postedAt, new Date("2026-06-09T06:46:35+0000").toISOString());

  const p2 = normalizeRecruiterflow(company, "coinswitch", remote);
  assert.equal(p2.isRemote, true);
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("recruiterflowAdapter.listPostings fetches the board HTML and returns normalized postings", async () => {
  stubFetch(async (input) => {
    assert.equal(String(input), "https://recruiterflow.com/coinswitch/jobs");
    return new Response(LIST_HTML, { status: 200, headers: { "content-type": "text/html" } });
  });
  try {
    const postings = await recruiterflowAdapter.listPostings(company);
    assert.equal(postings.length, 2);
    assert.deepEqual(postings.map((p) => p.externalId).sort(), ["676", "692"]);
  } finally {
    restoreFetch();
  }
});

test("recruiterflowAdapter.fetchJd fetches the job detail page and extracts the JD", async () => {
  stubFetch(async (input) => {
    assert.equal(String(input), "https://recruiterflow.com/coinswitch/jobs/692");
    return new Response(JD_HTML, { status: 200, headers: { "content-type": "text/html" } });
  });
  try {
    const posting = normalizeRecruiterflow(company, "coinswitch", at(parseRecruiterflowJobsList(LIST_HTML), 0));
    assert(recruiterflowAdapter.fetchJd);
    const jd = await recruiterflowAdapter.fetchJd(company, posting);
    assert.match(jd, /Lead our brand campaigns/);
  } finally {
    restoreFetch();
  }
});
