// src/ats/trakstar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trakstarListUrl,
  parseTrakstarHref,
  parseTrakstarList,
  parseTrakstarJd,
} from "./trakstar.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "trakstar",
  slug: "acme",
  name: "Acme Corp",
  careersUrl: "https://acme.hire.trakstar.com/",
  tenantUrl: "https://acme.hire.trakstar.com/",
  apiMeta: null,
};

// Trimmed real markup shape from GET / (three rows: one missing location, one
// duplicate slug to prove dedup).
const LIST_HTML = `
<html><body>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/business-analyst/">
      <h3 class="js-job-list-opening-name">Business Analyst</h3>
      <div class="meta-job-location-city">Bengaluru, India</div>
    </a>
  </div>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/software-engineer-remote/">
      <h3 class="js-job-list-opening-name">Software Engineer (Remote)</h3>
    </a>
  </div>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/business-analyst/">
      <h3 class="js-job-list-opening-name">Business Analyst</h3>
      <div class="meta-job-location-city">Bengaluru, India</div>
    </a>
  </div>
</body></html>
`;

const JD_HTML = `
<html><body>
  <div class="jobdesciption">
    <div><strong>Roles &amp; Responsibilities.<br></strong>* Track business numbers<br>* Build dashboards<br></div>
  </div>
</body></html>
`;

test("trakstarListUrl derives the tenant origin for page 1 (bare origin)", () => {
  assert.equal(trakstarListUrl(company), "https://acme.hire.trakstar.com");
  assert.equal(
    trakstarListUrl({ ...company, tenantUrl: null }),
    "https://acme.hire.trakstar.com",
  );
});

test("parseTrakstarHref extracts the slug from a /jobs/<slug>/ path", () => {
  assert.deepEqual(parseTrakstarHref("/jobs/business-analyst/"), { slug: "business-analyst" });
  assert.deepEqual(parseTrakstarHref("/jobs/business-analyst/?src=x"), {
    slug: "business-analyst",
  });
  assert.equal(parseTrakstarHref("/jobs/"), null);
  assert.equal(parseTrakstarHref("/careers/business-analyst/"), null);
});

test("parseTrakstarList maps rows: title, location (tolerating absence), isRemote, absolute URL, and dedups by slug", () => {
  const postings = parseTrakstarList(LIST_HTML, company);
  assert.equal(postings.length, 2);

  const [ba, se] = postings;
  assert.equal(ba?.provider, "trakstar");
  assert.equal(ba.externalId, "business-analyst");
  assert.equal(ba.jobTitle, "Business Analyst");
  assert.equal(ba.jobUrl, "https://acme.hire.trakstar.com/jobs/business-analyst/");
  assert.equal(ba.location, "Bengaluru, India");
  assert.equal(ba.isRemote, false);
  assert.equal(ba.jdText, "");
  assert.equal(ba.postedAt, null);

  assert.equal(se?.externalId, "software-engineer-remote");
  assert.equal(se.jobTitle, "Software Engineer (Remote)");
  assert.equal(se.location, null);
  assert.equal(se.isRemote, false);
});

test("parseTrakstarList detects remote via REMOTE_RE on the location text", () => {
  const remoteHtml = `
    <div class="js-careers-page-job-list-item">
      <a href="/jobs/remote-role/">
        <h3 class="js-job-list-opening-name">Remote Role</h3>
        <div class="meta-job-location-city">Remote</div>
      </a>
    </div>`;
  const postings = parseTrakstarList(remoteHtml, company);
  assert.equal(postings[0]?.isRemote, true);
});

test("parseTrakstarList returns [] when there are no job-list-item rows (empty board / layout change)", () => {
  assert.deepEqual(parseTrakstarList("<html><body>No jobs right now.</body></html>", company), []);
});

test("parseTrakstarList skips a row whose href doesn't match /jobs/<slug>/ and one with no title", () => {
  const malformed = `
    <div class="js-careers-page-job-list-item">
      <a href="/careers/bad-href/"><h3 class="js-job-list-opening-name">Bad Href</h3></a>
    </div>
    <div class="js-careers-page-job-list-item">
      <a href="/jobs/no-title/"></a>
    </div>`;
  assert.deepEqual(parseTrakstarList(malformed, company), []);
});

test("parseTrakstarJd extracts the JD text from div.jobdesciption (vendor's misspelling)", () => {
  const jd = parseTrakstarJd(JD_HTML);
  assert.match(jd, /Track business numbers/);
  assert.match(jd, /Build dashboards/);
  assert.doesNotMatch(jd, /<div>|<strong>/);
});

test("parseTrakstarJd returns '' when div.jobdesciption is absent (malformed/changed page)", () => {
  assert.equal(parseTrakstarJd("<html><body>Not found</body></html>"), "");
});
