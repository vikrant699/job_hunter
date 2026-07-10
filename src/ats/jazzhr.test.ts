// src/ats/jazzhr.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jazzhrBase,
  parseJazzhrJobId,
  parseJazzhrList,
  normalizeJazzhr,
  extractJazzhrJd,
} from "./jazzhr.js";
import type { JazzhrListing } from "./jazzhr.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "jazzhr",
  slug: "hackerearth",
  name: "HackerEarth",
  careersUrl: "https://hackerearth.applytojob.com/apply",
  tenantUrl: null,
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
  assert.equal(listings[1]?.location, "Remote, India");
});

test("parseJazzhrList returns [] for an empty board (no list-group items)", () => {
  assert.deepEqual(parseJazzhrList(EMPTY_HTML, "https://smuleinc.applytojob.com/apply"), []);
});

test("parseJazzhrList skips rows with no href and rows with blank title, keeps valid ones", () => {
  const listings = parseJazzhrList(MALFORMED_HTML, "https://hackerearth.applytojob.com/apply");
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.id, "def456");
  assert.equal(listings[0]?.title, "Real Role");
});

test("parseJazzhrList returns [] for HTML with no list-group at all", () => {
  assert.deepEqual(parseJazzhrList("<html><body>Nothing here</body></html>", "https://x.applytojob.com/apply"), []);
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
