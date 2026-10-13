import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jazzhrAdapter,
  jazzhrBase,
  assertJazzhrOnTenantHost,
  assertJazzhrAccountActive,
  parseJazzhrJobId,
  parseJazzhrList,
  normalizeJazzhr,
  extractJazzhrJd,
} from "../jazzhr.js";
import type { JazzhrListing } from "../jazzhr.js";
import { fetchSequence, htmlResponseFrom, stubFetch } from "./testHelpers.js";
import { thrownBy } from "../../__tests__/caught.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "jazzhr",
  slug: "hackerearth",
  name: "HackerEarth",
  careersUrl: "https://hackerearth.applytojob.com/apply",
  tenantUrl: null,
  apiMeta: null,
};

const overrideCompany: AdapterCompany = {
  provider: "jazzhr",
  slug: "smule-india",
  name: "Smule India",
  careersUrl: "https://smuleinc.applytojob.com/apply",
  tenantUrl: "https://smuleinc.applytojob.com/apply",
  apiMeta: null,
};

const LIST_HTML = `<!DOCTYPE html>
<html><head><title>HackerEarth - Career Page</title></head>
<body>
<div class='col col-xs-7 jobs-list'>
    <h2 class='page-title page-title-open'>Current Openings</h2>
    <ul class='list-group'>
        <li class="list-group-item">
            <h3 class='list-group-item-heading'>
                <a href="https://hackerearth.applytojob.com/apply/8un9zUEE06/Account-Executive-SMB-Sales">
                    Account Executive - SMB Sales                </a>
            </h3>
            <ul class='list-inline list-group-item-text'>
                <li><i class='fa fa-map-marker'></i>Bangalore, Karnataka, India</li>
            </ul>
        </li>
        <li class="list-group-item">
            <h3 class='list-group-item-heading'>
                <a href="https://hackerearth.applytojob.com/apply/ZhjBt8T9ip/Senior-Software-Engineer-Backend">
                    Senior Software Engineer ( Backend)                </a>
            </h3>
            <ul class='list-inline list-group-item-text'>
                <li><i class='fa fa-map-marker'></i>Remote, India</li>
            </ul>
        </li>
    </ul>
</div>
</body></html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><head><title>Smule - Career Page</title></head>
<body>
<div class='col col-xs-7 jobs-list'>
    <h2 class='page-title'>There are no open positions at this time.</h2>
</div>
</body></html>`;

const MALFORMED_HTML = `<!DOCTYPE html>
<html><body>
<ul class='list-group'>
    <li class="list-group-item">
        <h3 class='list-group-item-heading'><a>No href here</a></h3>
        <ul class='list-inline list-group-item-text'><li>Nowhere</li></ul>
    </li>
    <li class="list-group-item">
        <h3 class='list-group-item-heading'>
            <a href="https://hackerearth.applytojob.com/apply/abc123/Some-Role">   </a>
        </h3>
    </li>
    <li class="list-group-item">
        <h3 class='list-group-item-heading'>
            <a href="https://hackerearth.applytojob.com/apply/def456/Real-Role">Real Role</a>
        </h3>
        <ul class='list-inline list-group-item-text'><li>Pune, India</li></ul>
    </li>
</ul>
</body></html>`;

// An unhosted slug lands on the www.jazzhr.com marketing page with no list-group items.
const MARKETING_HTML = `<!DOCTYPE html>
<html><head>
<title>For Job Seekers | JazzHR</title>
<link rel="canonical" href="https://www.jazzhr.com/job-seekers"/>
</head>
<body>
<h1 class="text-primary-900 font-bold">Trying to apply for a job?</h1>
<p>JazzHR is recruiting software used by thousands of small businesses.</p>
</body></html>`;

// A cancelled account still 200s on its own host with an empty board; only the page text says so.
const INACTIVE_HTML = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="description" content="This JazzHR account is no longer active." />
<title>JazzHR - Inactive Career Page</title>
</head><body><div>This account is no longer active. <a href="https://www.jazzhr.com">Learn more about JazzHR.</a></div></body></html>`;

const JD_HTML = `<!DOCTYPE html>
<html><body>
<div class="job-attributes-container">
    <div title="Location"><i class='fa fa-map-marker'></i>Bangalore, Karnataka, India</div>
    <div id='resumator-job-employment' title="Type"><i class='fa fa-clock-o'></i>Full Time</div>
</div>
<div class='col col-xs-7 description' id="job-description">
    <span>HackerEarth is a developer assessment platform.<br><br>You are great for this role if you have:</span>
    <ul><li><span>Proven experience selling to C-level executives.</span></li></ul>
</div>
</body></html>`;

test("jazzhrBase derives the tenant origin from the slug when tenantUrl is unset", () => {
  assert.equal(jazzhrBase(company), "https://hackerearth.applytojob.com");
});

test("jazzhrBase prefers an explicit tenantUrl host when set", () => {
  const c: AdapterCompany = { ...company, tenantUrl: "https://hackerearth.applytojob.com/apply" };
  assert.equal(jazzhrBase(c), "https://hackerearth.applytojob.com");
});

test("parseJazzhrJobId extracts the id path segment from /apply/<id>/<slug>", () => {
  assert.equal(
    parseJazzhrJobId("https://hackerearth.applytojob.com/apply/8un9zUEE06/Account-Executive-SMB-Sales"),
    "8un9zUEE06",
  );
});

test("parseJazzhrJobId returns null for a URL with no /apply/<id>/<slug> shape", () => {
  assert.equal(parseJazzhrJobId("https://hackerearth.applytojob.com/apply"), null);
});

test("parseJazzhrList extracts every posting with its title, url, and location", () => {
  const listings = parseJazzhrList(LIST_HTML, "https://hackerearth.applytojob.com/apply");
  assert.equal(listings.length, 2);
  assert.deepEqual(listings[0], {
    id: "8un9zUEE06",
    title: "Account Executive - SMB Sales",
    url: "https://hackerearth.applytojob.com/apply/8un9zUEE06/Account-Executive-SMB-Sales",
    location: "Bangalore, Karnataka, India",
  });
  assert.equal(listings[1]?.title, "Senior Software Engineer ( Backend)");
  assert.equal(listings[1].location, "Remote, India");
});

test("parseJazzhrList returns [] for an empty board (no list-group items)", () => {
  assert.deepEqual(parseJazzhrList(EMPTY_HTML, "https://smuleinc.applytojob.com/apply"), []);
});

test("parseJazzhrList skips rows with no href and rows with blank title, keeps valid ones", () => {
  const listings = parseJazzhrList(MALFORMED_HTML, "https://hackerearth.applytojob.com/apply");
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.id, "def456");
  assert.equal(listings[0].title, "Real Role");
});

test("parseJazzhrList returns [] for HTML with no list-group at all", () => {
  assert.deepEqual(parseJazzhrList("<html><body>Nothing here</body></html>", "https://x.applytojob.com/apply"), []);
});

test("assertJazzhrOnTenantHost throws when the board answered from another host, naming both", () => {
  const err = thrownBy(() =>
    assertJazzhrOnTenantHost(
      "https://hackerearth.applytojob.com",
      "https://www.jazzhr.com/job-seekers",
    ),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /jazzhr: tenant does not exist/);
  assert.match(err.message, /hackerearth\.applytojob\.com/);
  assert.match(err.message, /www\.jazzhr\.com/);
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", () => {
  const err = thrownBy(() =>
    assertJazzhrOnTenantHost(
      "https://hackerearth.applytojob.com",
      "https://www.jazzhr.com/job-seekers",
    ),
  );
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("assertJazzhrOnTenantHost tolerates www./path differences on the SAME host", () => {
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost(
      "https://hackerearth.applytojob.com",
      "https://hackerearth.applytojob.com/apply/",
    ),
  );
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost(
      "https://hackerearth.applytojob.com",
      "https://www.hackerearth.applytojob.com/apply?src=x",
    ),
  );
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost(
      "https://www.hackerearth.applytojob.com",
      "https://hackerearth.applytojob.com/apply",
    ),
  );
});

test("assertJazzhrOnTenantHost stays silent when either URL is unparseable", () => {
  assert.doesNotThrow(() => assertJazzhrOnTenantHost("not a url", "https://www.jazzhr.com/"));
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost("https://hackerearth.applytojob.com", "not a url"),
  );
});

test("assertJazzhrOnTenantHost takes the expected host from a tenant_url override, not the slug", () => {
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost(jazzhrBase(overrideCompany), "https://smuleinc.applytojob.com/apply"),
  );
  const err = thrownBy(() =>
    assertJazzhrOnTenantHost(jazzhrBase(overrideCompany), "https://www.jazzhr.com/job-seekers"),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /smuleinc\.applytojob\.com/);
});

test("jazzhrAdapter.listPostings rejects a dead tenant that landed on JazzHR's marketing page", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://www.jazzhr.com/job-seekers", MARKETING_HTML)));
  await assert.rejects(
    () => jazzhrAdapter.listPostings(company),
    /jazzhr: tenant does not exist.*hackerearth\.applytojob\.com.*www\.jazzhr\.com/,
  );
});

test("jazzhrAdapter.listPostings rejects an off-host response even when its HTML parses", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://www.jazzhr.com/job-seekers", LIST_HTML)));
  await assert.rejects(() => jazzhrAdapter.listPostings(company), /jazzhr: tenant does not exist/);
});

test("jazzhrAdapter.listPostings returns [] for a LIVE tenant whose board has no open roles", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://smuleinc.applytojob.com/apply", EMPTY_HTML)));
  assert.deepEqual(await jazzhrAdapter.listPostings(overrideCompany), []);
});

test("assertJazzhrAccountActive throws on JazzHR's inactive-account page, charged to the company", () => {
  const err = thrownBy(() => assertJazzhrAccountActive(INACTIVE_HTML, "https://smuleinc.applytojob.com/apply"));
  assert.ok(err instanceof Error);
  assert.match(err.message, /jazzhr: account no longer active/);
  assert.match(err.message, /smuleinc.applytojob.com/);
  assert.equal(isInfrastructureFault(err), false);
});

test("assertJazzhrAccountActive stays silent on a live empty board and a populated one", () => {
  assert.doesNotThrow(() => assertJazzhrAccountActive(EMPTY_HTML, "https://smuleinc.applytojob.com/apply"));
  assert.doesNotThrow(() => assertJazzhrAccountActive(LIST_HTML, "https://hackerearth.applytojob.com/apply"));
});

test("jazzhrAdapter.listPostings rejects an inactive account instead of reporting an empty board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://smuleinc.applytojob.com/apply", INACTIVE_HTML)));
  await assert.rejects(() => jazzhrAdapter.listPostings(overrideCompany), /jazzhr: account no longer active/);
});

test("jazzhrAdapter.listPostings still lists a populated board unchanged", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://hackerearth.applytojob.com/apply", LIST_HTML)));
  const postings = await jazzhrAdapter.listPostings(company);
  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.externalId, "8un9zUEE06");
  assert.equal(postings[0].jobUrl, "https://hackerearth.applytojob.com/apply/8un9zUEE06/Account-Executive-SMB-Sales");
  assert.equal(postings[1]?.isRemote, true);
});

test("jazzhrAdapter.listPostings accepts a tenant_url override's host on a populated board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponseFrom("", LIST_HTML)));
  const postings = await jazzhrAdapter.listPostings(overrideCompany);
  assert.equal(postings.length, 2);
});

test("normalizeJazzhr maps fields and sets isRemote from the location text", () => {
  const listing: JazzhrListing = {
    id: "ZhjBt8T9ip",
    title: "Senior Software Engineer ( Backend)",
    url: "https://hackerearth.applytojob.com/apply/ZhjBt8T9ip/Senior-Software-Engineer-Backend",
    location: "Remote, India",
  };
  const p = normalizeJazzhr(company, listing);
  assert.equal(p.provider, "jazzhr");
  assert.equal(p.externalId, "ZhjBt8T9ip");
  assert.equal(p.companySlug, "hackerearth");
  assert.equal(p.jobTitle, "Senior Software Engineer ( Backend)");
  assert.equal(p.jobUrl, listing.url);
  assert.equal(p.location, "Remote, India");
  assert.equal(p.isRemote, true);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeJazzhr sets isRemote false and location null when the listing has no location", () => {
  const listing: JazzhrListing = {
    id: "abc",
    title: "Role",
    url: "https://hackerearth.applytojob.com/apply/abc/Role",
    location: null,
  };
  const p = normalizeJazzhr(company, listing);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("extractJazzhrJd pulls the #job-description div and strips HTML to plain text", () => {
  const jd = extractJazzhrJd(JD_HTML);
  assert.match(jd, /HackerEarth is a developer assessment platform\./);
  assert.match(jd, /Proven experience selling to C-level executives\./);
  assert.doesNotMatch(jd, /<span>|<ul>|<li>/);
});

test("extractJazzhrJd returns empty string when #job-description is missing", () => {
  assert.equal(extractJazzhrJd("<html><body><p>no jd here</p></body></html>"), "");
});
