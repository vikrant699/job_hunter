import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breezyBase,
  normalizeBreezyhr,
  parseBreezyJobs,
  extractBreezyJd,
  BreezyJobSchema,
  type BreezyJob,
} from "../breezyhr.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "breezyhr",
  slug: "talentmovers",
  name: "TalentMovers",
  careersUrl: "https://talentmovers.breezy.hr",
  tenantUrl: "https://talentmovers.breezy.hr",
  apiMeta: null,
};

// Trimmed real item from GET https://talentmovers.breezy.hr/json
const job: BreezyJob = {
  id: "c54d86f96c6e",
  friendly_id: "c54d86f96c6e-auto-body-technician-en",
  name: "Auto Body Technician (EN)",
  url: "https://talentmovers.breezy.hr/p/c54d86f96c6e-auto-body-technician-en",
  published_date: "2026-06-04T17:00:16.975Z",
  type: { id: "fullTime", name: "Full-Time" },
  location: { name: "United States", is_remote: null },
  department: null,
};

test("breezyBase prefers tenant_url origin, falls back to slug subdomain", () => {
  assert.equal(breezyBase(company), "https://talentmovers.breezy.hr");
  assert.equal(breezyBase({ ...company, tenantUrl: null }), "https://talentmovers.breezy.hr");
});

test("BreezyJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(BreezyJobSchema.safeParse(job).success);
  assert.ok(BreezyJobSchema.safeParse({ id: "x", friendly_id: "y", name: "z" }).success);
  assert.equal(BreezyJobSchema.safeParse({ friendly_id: "y", name: "z" }).success, false);
});

test("parseBreezyJobs accepts an empty board", () => {
  assert.deepEqual(parseBreezyJobs([], "talentmovers"), []);
});

test("parseBreezyJobs throws on a non-array top-level response", () => {
  assert.throws(() => parseBreezyJobs({ jobs: [] }, "talentmovers"), /was not an array/);
  assert.throws(() => parseBreezyJobs(null, "talentmovers"), /was not an array/);
});

test("parseBreezyJobs skips malformed items but keeps valid ones", () => {
  const raw = [job, { friendly_id: "no-id-or-name" }, { id: "x", friendly_id: "y", name: "z" }];
  const out = parseBreezyJobs(raw, "talentmovers");
  assert.equal(out.length, 2);
  assert.equal(out[0]?.id, "c54d86f96c6e");
  assert.equal(out[1]?.id, "x");
});

test("normalizeBreezyhr maps fields: id, title, location name, job url, posted date", () => {
  const p = normalizeBreezyhr(company, job);
  assert.equal(p.provider, "breezyhr");
  assert.equal(p.externalId, "c54d86f96c6e");
  assert.equal(p.jobTitle, "Auto Body Technician (EN)");
  assert.equal(p.jobUrl, "https://talentmovers.breezy.hr/p/c54d86f96c6e-auto-body-technician-en");
  assert.equal(p.location, "United States");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, ""); // list endpoint carries no description
  assert.equal(p.postedAt, "2026-06-04T17:00:16.975Z");
});

test("normalizeBreezyhr synthesizes a job URL from friendly_id when url is absent", () => {
  const p = normalizeBreezyhr(company, { ...job, url: null });
  assert.equal(p.jobUrl, "https://talentmovers.breezy.hr/p/c54d86f96c6e-auto-body-technician-en");
});

test("normalizeBreezyhr honors an explicit is_remote flag", () => {
  const p = normalizeBreezyhr(company, { ...job, location: { name: "United States", is_remote: true } });
  assert.equal(p.isRemote, true);
});

test("normalizeBreezyhr falls back to REMOTE_RE on the location name when is_remote is absent", () => {
  const p = normalizeBreezyhr(company, { ...job, location: { name: "Remote - US", is_remote: null } });
  assert.equal(p.isRemote, true);
});

test("normalizeBreezyhr leaves location null when the field is absent", () => {
  const p = normalizeBreezyhr(company, { ...job, location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

// "simple" theme (e.g. talentmovers): <div class="job-description"><div class="description">...
const SIMPLE_THEME_HTML = `
<html><body class="breezy-portal breezy-portal-simple">
<div class="position-header"><h1>Auto Body Technician (EN)</h1></div>
<div class="job-description"><div class="description">
  <p><strong>Join our team</strong></p>
  <p>Repair vehicles to spec.</p>
  <ul><li>ASE certification preferred</li></ul>
</div></div>
<div class="apply-container"><a href="/apply">Apply now</a></div>
</body></html>`;

// "bold" theme (e.g. fairsquare): #description.position-description wraps
// breadcrumbs/sidebar/links as SIBLINGS of the real .description div.
const BOLD_THEME_HTML = `
<html><body class="breezy-portal breezy-portal-bold">
<div id="description" class="container position-description">
  <div class="container-wrapper">
    <ul class="breadcrumbs"><li>Job Openings</li></ul>
    <div class="sidebar-container">Apply using LinkedIn</div>
    <div class="links-container">Glassdoor</div>
    <div class="description">
      <p><strong>Director of Data Engineering</strong> - San Diego, CA</p>
      <p>Build and scale our data infrastructure.</p>
    </div>
  </div>
</div>
</body></html>`;

test("extractBreezyJd pulls the innermost .description text on the simple theme", () => {
  const text = extractBreezyJd(SIMPLE_THEME_HTML);
  assert.match(text, /Join our team/);
  assert.match(text, /Repair vehicles to spec/);
  assert.match(text, /ASE certification preferred/);
  assert.doesNotMatch(text, /<p>|<li>/);
  assert.doesNotMatch(text, /Apply now/);
});

test("extractBreezyJd pulls only the innermost .description text on the bold theme, excluding sidebar siblings", () => {
  const text = extractBreezyJd(BOLD_THEME_HTML);
  assert.match(text, /Director of Data Engineering/);
  assert.match(text, /Build and scale our data infrastructure/);
  assert.doesNotMatch(text, /Job Openings/);
  assert.doesNotMatch(text, /LinkedIn/);
  assert.doesNotMatch(text, /Glassdoor/);
});

test("extractBreezyJd returns empty string when there's no .description div at all", () => {
  assert.equal(extractBreezyJd("<html><body><p>no description here</p></body></html>"), "");
});
