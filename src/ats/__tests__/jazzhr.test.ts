// src/ats/jazzhr.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jazzhrAdapter,
  jazzhrBase,
  assertJazzhrOnTenantHost,
  parseJazzhrJobId,
  parseJazzhrList,
  normalizeJazzhr,
  extractJazzhrJd,
} from "../jazzhr.js";
import type { JazzhrListing } from "../jazzhr.js";
import { fetchSequence, htmlResponseFrom, stubFetch } from "./testHelpers.js";
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

// Smule's registry row: the JazzHR subdomain (smuleinc) is NOT the slug
// (smule-india), so the expected host can only come from the row's URL — a
// slug-derived host would be smule-india.applytojob.com, which is nobody's board.
const overrideCompany: AdapterCompany = {
  provider: "jazzhr",
  slug: "smule-india",
  name: "Smule India",
  careersUrl: "https://smuleinc.applytojob.com/apply",
  tenantUrl: "https://smuleinc.applytojob.com/apply",
  apiMeta: null,
};

// Trimmed from a live capture (hackerearth.applytojob.com/apply).
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

// Trimmed from a live capture (smuleinc.applytojob.com/apply) — zero open roles.
const EMPTY_HTML = `<!DOCTYPE html>
<html><head><title>Smule - Career Page</title></head>
<body>
<div class='col col-xs-7 jobs-list'>
    <h2 class='page-title'>There are no open positions at this time.</h2>
</div>
</body></html>`;

// A row missing the detail link and a row with no heading text — both must
// be skipped rather than crashing the parse.
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

// Trimmed from GET https://zzz-no-such-tenant-9x.applytojob.com/apply (HTTP 200,
// two redirects, 46,936 bytes, captured 2026-08-03). A slug JazzHR does not host
// lands here — the vendor's own job-seeker marketing page, on www.jazzhr.com. No
// list-group items, so it used to parse as a board with zero openings.
const MARKETING_HTML = `<!DOCTYPE html>
<html><head>
<title>For Job Seekers | JazzHR</title>
<link rel="canonical" href="https://www.jazzhr.com/job-seekers"/>
</head>
<body>
<h1 class="text-primary-900 font-bold">Trying to apply for a job?</h1>
<p>JazzHR is recruiting software used by thousands of small businesses.</p>
</body></html>`;

// Trimmed from a live capture of the detail page's #job-description div.
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

// --- dead tenant (redirected off-host) vs genuinely empty board ----------------

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

test("assertJazzhrOnTenantHost throws when the board answered from another host, naming both", () => {
  const err = thrownBy(() =>
    assertJazzhrOnTenantHost(
      "https://hackerearth.applytojob.com",
      "https://www.jazzhr.com/job-seekers",
    ),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /jazzhr: tenant does not exist/);
  // Both hosts, so the stored error alone says which tenant and where it went.
  assert.match(err.message, /hackerearth\.applytojob\.com/);
  assert.match(err.message, /www\.jazzhr\.com/);
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", () => {
  // A slug JazzHR does not host is a real per-company defect and MUST count
  // toward the row's consecutive_failures. If any of these flipped true the
  // scheduler would retry the board forever and never quarantine it.
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
  // A URL-shape oddity is not evidence about the board, so it must not fail one.
  assert.doesNotThrow(() => assertJazzhrOnTenantHost("not a url", "https://www.jazzhr.com/"));
  assert.doesNotThrow(() =>
    assertJazzhrOnTenantHost("https://hackerearth.applytojob.com", "not a url"),
  );
});

test("assertJazzhrOnTenantHost takes the expected host from a tenant_url override, not the slug", () => {
  // smule-india.applytojob.com is nobody's board; smuleinc.applytojob.com is.
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
  // The host is the whole signal: postings served from somewhere other than the
  // tenant are not this company's, so a parseable body must not excuse them.
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://www.jazzhr.com/job-seekers", LIST_HTML)));
  await assert.rejects(() => jazzhrAdapter.listPostings(company), /jazzhr: tenant does not exist/);
});

test("jazzhrAdapter.listPostings returns [] for a LIVE tenant whose board has no open roles", async (t) => {
  // The distinction the check exists for: same host, nothing open, no error.
  stubFetch(t, fetchSequence(() => htmlResponseFrom("https://smuleinc.applytojob.com/apply", EMPTY_HTML)));
  assert.deepEqual(await jazzhrAdapter.listPostings(overrideCompany), []);
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
  // No res.url at all (the fetch never redirected): finalUrl falls back to the
  // requested URL, which is the override host — the check must pass, not fire.
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
