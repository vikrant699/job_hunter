import { test } from "node:test";
import assert from "node:assert/strict";
import { sirionListUrl, parseSirionList, sirionPagePostings, parseSirionJobTitle, parseSirionJobLocation, parseSirionJd } from "../sirion.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";
import { thrownBy } from "../../__tests__/caught.js";

const company: AdapterCompany = {
  provider: "sirion",
  slug: "sirion-labs",
  name: "SirionLabs",
  careersUrl: "https://www.sirion.ai/careers/",
  tenantUrl: null,
  apiMeta: null,
};

test("sirionListUrl builds page 1 as /careers/ and page N as /careers/page/N/", () => {
  assert.equal(sirionListUrl(1), "https://www.sirion.ai/careers/");
  assert.equal(sirionListUrl(3), "https://www.sirion.ai/careers/page/3/");
});

const LIST_HTML = `<html><body><main>
  <article class="job"><h2><a href="https://www.sirion.ai/jobs/senior-frontend-engineer/">Senior Frontend Engineer</a></h2></article>
  <article class="job"><h2><a href="/jobs/staff-devops-engineer/">Staff DevOps Engineer</a></h2></article>
  <a href="/about/">About</a>
</main></body></html>`;

test("parseSirionList maps each /jobs/<slug>/ card: slug id, title, absolute url, deferred (null) location", () => {
  const posts = parseSirionList(company, LIST_HTML);
  assert.equal(posts.length, 2);
  const fe = at(posts, 0);
  assert.equal(fe.provider, "sirion");
  assert.equal(fe.externalId, "senior-frontend-engineer");
  assert.equal(fe.jobTitle, "Senior Frontend Engineer");
  assert.equal(fe.jobUrl, "https://www.sirion.ai/jobs/senior-frontend-engineer/");
  assert.equal(fe.location, null);
});

test("parseSirionList falls back to a de-kebabed slug when the card has no title text", () => {
  const html = `<html><body><a href="/jobs/principal-product-manager/"></a></body></html>`;
  const posts = parseSirionList(company, html);
  assert.equal(at(posts, 0).jobTitle, "Principal Product Manager");
});

test("parseSirionList dedupes a slug seen twice and returns [] with no job links", () => {
  const dup = `<html><body><a href="/jobs/x/">X</a><a href="/jobs/x/">X again</a></body></html>`;
  assert.equal(parseSirionList(company, dup).length, 1);
  assert.deepEqual(parseSirionList(company, "<html><body><p>none</p></body></html>"), []);
});

const AKAMAI_DENIED = `<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;sirion&#46;ai&#47;careers&#47;" on this server.<P>
Reference&#32;&#35;18&#46;8fbb2e17&#46;1791900903&#46;2ab3dfd</BODY></HTML>`;

test("sirionPagePostings throws an edge refusal on an Akamai Access Denied page instead of reporting an empty board", () => {
  const err = thrownBy(() => sirionPagePostings(company, sirionListUrl(1), AKAMAI_DENIED));
  assert.match(String(err), /edge refused/);
});

test("sirionPagePostings returns the parsed rows, and [] for a genuine page with no job links", () => {
  assert.equal(sirionPagePostings(company, sirionListUrl(1), LIST_HTML).length, 2);
  assert.deepEqual(sirionPagePostings(company, sirionListUrl(3), "<html><body><p>none</p></body></html>"), []);
});

// WordPress encodes location in the body class as gh_office-<city>.
const JOB_HTML = `<html><head><title>Senior Frontend Engineer - SirionLabs</title></head>
<body class="single single-jobs postid-24189 gh_department-engineering gh_office-gurugram">
  <main><article class="gh-job-single">
    <h1>Senior Frontend Engineer</h1>
    <div class="entry-content"><p>Build React apps.</p><ul><li>5+ years JS.</li></ul></div>
  </article></main>
</body></html>`;

test("parseSirionJobTitle prefers the <h1>, falling back to a cleaned <title>", () => {
  assert.equal(parseSirionJobTitle(JOB_HTML), "Senior Frontend Engineer");
  assert.equal(parseSirionJobTitle("<html><head><title>Data Scientist - SirionLabs</title></head><body></body></html>"), "Data Scientist");
});

test("parseSirionJobLocation reads the gh_office-<city> body class, title-cased, else null", () => {
  assert.equal(parseSirionJobLocation(JOB_HTML), "Gurugram");
  assert.equal(parseSirionJobLocation(`<body class="single gh_office-san_francisco">`), "San Francisco");
  assert.equal(parseSirionJobLocation("<body class='single'>"), null);
});

test("parseSirionJd extracts the job body as plain text from the gh-job-single/content block", () => {
  const jd = parseSirionJd(JOB_HTML);
  assert.match(jd, /Build React apps\./);
  assert.match(jd, /5\+ years JS\./);
  assert.doesNotMatch(jd, /<p>/);
});

test("parseSirionJd returns '' when no recognizable content block is present", () => {
  assert.equal(parseSirionJd("<html><body><nav>menu only</nav></body></html>"), "");
});
