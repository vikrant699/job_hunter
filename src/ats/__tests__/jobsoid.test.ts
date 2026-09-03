import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertJobsoidTenantExists,
  jobsoidAdapter,
  jobsoidIdFromHref,
  parseJobsoidList,
  jobsoidJdFromHtml,
} from "../jobsoid.js";
import type { AdapterCompany } from "../../types.js";
import { at, fetchSequence, htmlResponseFrom, stubFetch } from "./testHelpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";

const company: AdapterCompany = {
  provider: "jobsoid",
  slug: "vibvzw",
  name: "VIB",
  careersUrl: "https://vibvzw.jobsoid.com/",
  tenantUrl: "https://vibvzw.jobsoid.com",
  apiMeta: null,
};

const plainHostCompany: AdapterCompany = {
  provider: "jobsoid",
  slug: "cuemath",
  name: "Cuemath",
  careersUrl: "https://cuemath.jobsoid.com/",
  tenantUrl: "https://cuemath.jobsoid.com/",
  apiMeta: null,
};

// tenant_url null; host resolution falls back to careers_url.
const careersUrlOnlyCompany: AdapterCompany = {
  provider: "jobsoid",
  slug: "webbeds",
  name: "WebBeds",
  careersUrl: "https://webbeds.jobsoid.com/",
  tenantUrl: null,
  apiMeta: null,
};

// Real markup from vibvzw.jobsoid.com, which redirects to jobs.vib.be.
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

// Real markup; the JSON-LD block is on one line in production, wrapped here for readability.
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

// A live tenant with an empty board: normal chrome, "No Current Openings" heading, no job anchors.
const EMPTY_BOARD_HTML = `
<html><head><title>Careers @ cuemath</title>
<link rel="canonical" href="https://cuemath.jobsoid.com"></head><body>
<section class="section current-openings" id="sectionContainer" data-section="1">
  <h2 class="section-title cm-container">Current Openings</h2>
  <h3 class="text-center">No Current Openings</h3>
</section>
</body></html>`;

// Jobsoid's shared cross-tenant portal: a React shell listing other employers' postings, no job anchors - used to parse as an empty board.
const PORTAL_HTML = `<!DOCTYPE html><html lang="en"><head></head>
<body><div><div id="loading-splash"><p>Loading, please wait...</p></div></div>
<script>(self.__FLIGHT_DATA||=[]).push("{\\"jobs\\":[{\\"id\\":135306,\\"company\\":\\"Edge Tutor\\"}],\\"total\\":631}")</script>
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

/** Run `fn` and hand back whatever it threw, failing the test if it returned. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

test("assertJobsoidTenantExists throws when the board came from Jobsoid's shared portal, naming both hosts", () => {
  const err = thrownBy(() =>
    assertJobsoidTenantExists("https://cuemath.jobsoid.com", "https://portal.jobsoid.com/?notfound=true"),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /jobsoid: tenant does not exist/);
  // Both hosts, so the stored error alone says which tenant and where it went.
  assert.match(err.message, /cuemath\.jobsoid\.com/);
  assert.match(err.message, /portal\.jobsoid\.com/);
});

test("the dead-subdomain error is charged to the company, not written off as infrastructure", () => {
  // Must count toward consecutive_failures, or the scheduler retries forever instead of quarantining.
  const err = thrownBy(() =>
    assertJobsoidTenantExists("https://cuemath.jobsoid.com", "https://portal.jobsoid.com/?notfound=true"),
  );
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("assertJobsoidTenantExists stays silent for a CUSTOM-DOMAIN tenant, which legitimately leaves the host", () => {
  // Leaving the host is normal here; only the portal host may fail a board, or a healthy tenant gets quarantined.
  assert.doesNotThrow(() =>
    assertJobsoidTenantExists("https://vibvzw.jobsoid.com", "https://jobs.vib.be/"),
  );
});

test("assertJobsoidTenantExists stays silent on the tenant's own host and on unparseable URLs", () => {
  assert.doesNotThrow(() =>
    assertJobsoidTenantExists("https://cuemath.jobsoid.com", "https://cuemath.jobsoid.com/"),
  );
  assert.doesNotThrow(() =>
    assertJobsoidTenantExists("https://cuemath.jobsoid.com", "https://www.cuemath.jobsoid.com/?src=x"),
  );
  // A URL-shape oddity is not evidence about the board, so it must not fail one.
  assert.doesNotThrow(() => assertJobsoidTenantExists("not a url", "also not a url"));
});

test("assertJobsoidTenantExists ignores a leading www. on the portal host", () => {
  const err = thrownBy(() =>
    assertJobsoidTenantExists("https://cuemath.jobsoid.com", "https://www.portal.jobsoid.com/?notfound=true"),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /jobsoid: tenant does not exist/);
});

test("jobsoidAdapter.listPostings rejects a dead subdomain that landed on Jobsoid's portal", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://portal.jobsoid.com/?notfound=true", PORTAL_HTML)));
  await assert.rejects(
    () => jobsoidAdapter.listPostings(plainHostCompany),
    /jobsoid: tenant does not exist.*cuemath\.jobsoid\.com.*portal\.jobsoid\.com/,
  );
});

test("jobsoidAdapter.listPostings rejects a portal response even when its HTML would parse", async (t) => {
  // A parseable body must not excuse a response served from the portal - those jobs are not this company's.
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://portal.jobsoid.com/?notfound=true", LIST_HTML)));
  await assert.rejects(() => jobsoidAdapter.listPostings(plainHostCompany), /jobsoid: tenant does not exist/);
});

test("jobsoidAdapter.listPostings returns [] for a LIVE tenant whose board has no open roles", async (t) => {
  // The distinction the check exists for: same host, nothing open, no error.
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://cuemath.jobsoid.com/", EMPTY_BOARD_HTML)));
  assert.deepEqual(await jobsoidAdapter.listPostings(plainHostCompany), []);
});

test("jobsoidAdapter.listPostings still lists a populated board unchanged", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://webbeds.jobsoid.com/", LIST_HTML)));
  const postings = await jobsoidAdapter.listPostings(careersUrlOnlyCompany);
  assert.equal(postings.length, 2);
  assert.equal(at(postings, 0).externalId, "136131");
  assert.equal(at(postings, 0).jobUrl, "https://webbeds.jobsoid.com/j/136131/aankoper");
  assert.equal(at(postings, 0).companySlug, "webbeds");
});

test("jobsoidAdapter.listPostings still lists a populated CUSTOM-DOMAIN board unchanged", async (t) => {
  // The redirect target is where relative hrefs resolve, so it must survive the check and stay the link base.
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://jobs.vib.be/", LIST_HTML)));
  const postings = await jobsoidAdapter.listPostings(company);
  assert.equal(postings.length, 2);
  assert.equal(at(postings, 0).jobUrl, "https://jobs.vib.be/j/136131/aankoper");
});
