// src/ats/__tests__/google.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleListUrl, googleDetailUrl, parseGoogleList, parseGoogleJd } from "../google.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "google",
  slug: "google-india",
  name: "Google India",
  careersUrl: "https://www.google.com/about/careers/applications/jobs/results?location=India",
  tenantUrl: null,
  apiMeta: null,
};

test("googleListUrl builds the India-filtered, 1-based page URL", () => {
  assert.equal(
    googleListUrl(3),
    "https://www.google.com/about/careers/applications/jobs/results?location=India&page=3",
  );
});

test("googleDetailUrl strips the query and absolutizes a relative results href", () => {
  assert.equal(
    googleDetailUrl("jobs/results/107018346561446598-software-engineer-2026?location=India&page=1"),
    "https://www.google.com/about/careers/applications/jobs/results/107018346561446598-software-engineer-2026",
  );
});

// Each job card is an <li> with a jobs/results/<id>-<slug> link and an <h3> title.
const LIST_HTML = `<html><body><ul>
  <li><a href="jobs/results/107018346561446598-software-engineer-phd-early-career-2026?location=India&page=1"></a>
      <h3>Software Engineer, PhD, Early Career, 2026</h3></li>
  <li><a href="jobs/results/85183114006930118-product-manager-ai-platform?location=India&page=1"></a>
      <h3>Product Manager, AI Platform</h3></li>
  <li><a href="/somewhere/else">Not a job</a></li>
</ul></body></html>`;

test("parseGoogleList maps each card: numeric id, clean h3 title, absolute jobUrl, India location", () => {
  const posts = parseGoogleList(company, LIST_HTML);
  assert.equal(posts.length, 2);
  const se = at(posts, 0);
  assert.equal(se.provider, "google");
  assert.equal(se.externalId, "107018346561446598");
  assert.equal(se.jobTitle, "Software Engineer, PhD, Early Career, 2026");
  assert.equal(se.location, "India");
  assert.match(se.jobUrl, /\/jobs\/results\/107018346561446598-software-engineer-phd-early-career-2026$/);
  assert.equal(se.jdText, ""); // JD comes from fetchJd
});

test("parseGoogleList dedupes a repeated id and skips a card with no h3 title", () => {
  const withDupAndUntitled = `<html><body><ul>
    <li><a href="jobs/results/111-a?x=1"></a><h3>Role A</h3></li>
    <li><a href="jobs/results/111-a?x=2"></a><h3>Role A again</h3></li>
    <li><a href="jobs/results/222-b?x=1"></a></li>
  </ul></body></html>`;
  const posts = parseGoogleList(company, withDupAndUntitled);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.externalId, "111");
});

test("parseGoogleList returns [] on a page past the end (no job cards)", () => {
  assert.deepEqual(parseGoogleList(company, "<html><body><p>No results</p></body></html>"), []);
});

// JD extraction keys on STABLE <h3> heading TEXT (About the job / Minimum
// qualifications / Responsibilities), not on Google's rotating CSS classes.
const DETAIL_HTML = `<html><body>
  <header><a>share link</a><a>Copy link</a></header>
  <div class="X">
    <h1>Software Engineer</h1>
    <div class="jd-region">
      <h3>Minimum qualifications</h3><ul><li>Bachelor's degree.</li></ul>
      <h3>About the job</h3><p>Build things at scale.</p>
      <h3>Responsibilities</h3><ul><li>Write code.</li></ul>
    </div>
  </div>
  <footer>Google footer noise</footer>
</body></html>`;

test("parseGoogleJd extracts the JD region from the stable heading sections, dropping chrome", () => {
  const jd = parseGoogleJd(DETAIL_HTML);
  assert.match(jd, /Minimum qualifications/);
  assert.match(jd, /Bachelor's degree\./);
  assert.match(jd, /Build things at scale\./);
  assert.match(jd, /Write code\./);
  assert.doesNotMatch(jd, /Google footer noise/);
  assert.doesNotMatch(jd, /share link/);
});

test("parseGoogleJd returns '' when no known JD sections are present", () => {
  assert.equal(parseGoogleJd("<html><body><p>nothing here</p></body></html>"), "");
});
