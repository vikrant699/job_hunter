// src/ats/jobsoid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobsoidIdFromHref, parseJobsoidList, jobsoidJdFromHtml } from "./jobsoid.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "jobsoid",
  slug: "vibvzw",
  name: "VIB",
  careersUrl: "https://vibvzw.jobsoid.com/",
  tenantUrl: "https://vibvzw.jobsoid.com",
  apiMeta: null,
};

// Trimmed real markup from GET https://vibvzw.jobsoid.com/ (redirects to
// https://jobs.vib.be/), two department sections with one job each.
const LIST_HTML = `
<html><body>
<div class="">
  <div class="list-title">VIB Headquarters</div>
  <ul class="list">
    <li>
      <div class="row">
        <div class="col-md-19 job-location">
          <div class="title"><a class="jobDetailsLink" rel="canonical" href="/j/136131/aankoper">Aankoper</a></div>
          <div class="sub-title">
            <span class="r-space">
              <i class="tek-address"></i>
              <span>Ghent</span>
            </span>
            <span class="hidden-xs"><label class="label label-bordered">Finance</label></span>
          </div>
        </div>
        <div class="col-md-5 button-right"><a class="btn btn-default" href="/apply/136131">Apply</a></div>
      </div>
    </li>
  </ul>
</div>
<div class="">
  <div class="list-title">VIB Center for AI &amp; Computational Biology</div>
  <ul class="list">
    <li>
      <div class="row">
        <div class="col-md-19 job-location">
          <div class="title"><a class="jobDetailsLink" rel="canonical" href="/j/135914/machine-learning-ml-engineer-at-vibai">Machine Learning (ML) Engineer at VIB.AI</a></div>
          <div class="sub-title">
            <span class="r-space">
              <i class="tek-address"></i>
              <span>Brussels</span>
            </span>
            <span class="hidden-xs"><label class="label label-bordered">IT</label></span>
          </div>
        </div>
        <div class="col-md-5 button-right"><a class="btn btn-default" href="/apply/135914">Apply</a></div>
      </div>
    </li>
  </ul>
</div>
</body></html>`;

// Trimmed real markup from GET https://vibvzw.jobsoid.com/j/136131/aankoper
// (JSON-LD block is on one line in production; wrapped here for readability).
const DETAIL_HTML = `
<html><body>
<script type="application/ld+json">
{
  "@context": "http://schema.org/",
  "@type": "JobPosting",
  "title": "Aankoper",
  "description": "<p class=\\"text-justify\\">Ben jij een nauwkeurige aankoper?</p><ul><li>Aankoopbeheer</li></ul>",
  "identifier": { "@type": "PropertyValue", "name": "VIB", "value": "136131" },
  "datePosted": "07/01/2026 10:48:27",
  "validThrough": "",
  "hiringOrganization": { "@type": "Organization", "name": "VIB", "sameAs": "http://www.vib.be" },
  "jobLocation": {
    "@type": "Place",
    "address": { "@type": "PostalAddress", "addressLocality": "", "addressRegion": "", "addressCountry": "" }
  }
}
</script>
</body></html>`;

const EMPTY_BOARD_HTML = `
<html><body>
<div class="empty-state">No Current Openings</div>
</body></html>`;

test("jobsoidIdFromHref extracts the numeric id from a /j/<id>/<slug> href", () => {
  assert.equal(jobsoidIdFromHref("/j/136131/aankoper"), "136131");
  assert.equal(jobsoidIdFromHref("/apply/136131"), null);
  assert.equal(jobsoidIdFromHref("garbage"), null);
});

test("parseJobsoidList extracts every posting with title, location, and an absolute job URL resolved against the redirected host", () => {
  const postings = parseJobsoidList(LIST_HTML, "https://jobs.vib.be/", company);
  assert.equal(postings.length, 2);

  const first = at(postings, 0);
  assert.equal(first.provider, "jobsoid");
  assert.equal(first.externalId, "136131");
  assert.equal(first.jobTitle, "Aankoper");
  assert.equal(first.jobUrl, "https://jobs.vib.be/j/136131/aankoper");
  assert.equal(first.location, "Ghent");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, "");
  assert.equal(first.postedAt, null);

  const second = at(postings, 1);
  assert.equal(second.externalId, "135914");
  assert.equal(second.jobTitle, "Machine Learning (ML) Engineer at VIB.AI");
  assert.equal(second.location, "Brussels");
});

test("parseJobsoidList dedups by job id and skips malformed hrefs", () => {
  const dup = LIST_HTML.replace(
    "</ul>\n</div>\n<div class=\"\">\n  <div class=\"list-title\">VIB Center for AI &amp; Computational Biology</div>",
    "</ul>\n</div>\n<div class=\"\"><ul class=\"list\"><li><div class=\"title\"><a class=\"jobDetailsLink\" href=\"/j/136131/aankoper\">Aankoper (dup)</a></div></li></ul></div>\n<div class=\"\">\n  <div class=\"list-title\">VIB Center for AI &amp; Computational Biology</div>",
  );
  const postings = parseJobsoidList(dup, "https://jobs.vib.be/", company);
  assert.equal(postings.length, 2);
});

test("parseJobsoidList returns [] for an empty board", () => {
  assert.deepEqual(parseJobsoidList(EMPTY_BOARD_HTML, "https://cuemath.jobsoid.com/", company), []);
});

test("parseJobsoidList returns [] for markup with no job links at all", () => {
  assert.deepEqual(parseJobsoidList("<html><body><p>nothing here</p></body></html>", "https://x.jobsoid.com/", company), []);
});

test("jobsoidJdFromHtml pulls the description out of the JobPosting JSON-LD and strips HTML", () => {
  const jd = jobsoidJdFromHtml(DETAIL_HTML);
  assert.match(jd, /Aankoopbeheer/);
  assert.doesNotMatch(jd, /<p|<li/);
});

test("jobsoidJdFromHtml returns empty string when there's no JobPosting JSON-LD", () => {
  assert.equal(jobsoidJdFromHtml("<html><body><p>no ld+json here</p></body></html>"), "");
});
