// src/ats/dronahq.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dronahqListUrl,
  stripDronahqShortcodes,
  buildDronahqJd,
  dronahqLocationFromContent,
  dronahqWorkTypeFromContent,
  normalizeDronahqJob,
  type DronahqJob,
} from "./dronahq.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "dronahq",
  slug: "dronahq",
  name: "DronaHQ",
  careersUrl: "https://www.dronahq.com/career/",
  tenantUrl: null,
  apiMeta: null,
};

// --- URL builder -------------------------------------------------------------

test("dronahqListUrl builds the per_page/page-paged career CPT URL", () => {
  assert.equal(
    dronahqListUrl(1),
    "https://www.dronahq.com/wp-json/wp/v2/career?per_page=100&page=1",
  );
  assert.equal(
    dronahqListUrl(2),
    "https://www.dronahq.com/wp-json/wp/v2/career?per_page=100&page=2",
  );
});

// --- shortcode stripping ------------------------------------------------------

test("stripDronahqShortcodes removes WPBakery/vc_* tokens but leaves HTML intact", () => {
  const html = `[vc_row][vc_column]<p>Body copy.</p>[/vc_column][/vc_row]`;
  assert.equal(stripDronahqShortcodes(html), "<p>Body copy.</p>");
});

test("stripDronahqShortcodes handles shortcodes carrying attributes", () => {
  const html = `[vc_row css="123abc"][vc_column width="1/2"]<p>Text</p>[/vc_column][/vc_row]`;
  assert.equal(stripDronahqShortcodes(html), "<p>Text</p>");
});

test("stripDronahqShortcodes leaves plain text with no brackets untouched", () => {
  assert.equal(stripDronahqShortcodes("<p>No shortcodes here.</p>"), "<p>No shortcodes here.</p>");
});

// --- realistic fixture (trimmed from a live DronaHQ posting) ------------------

const SAMPLE_CONTENT_HTML = `[vc_row][vc_column]
    <div class="job-hero-banner-wrapper">
        <div class="job-title-and-description">
            <h1 class="job-title">
                QA Lead &#8211; SaaS (Low-Code/No-Code)
            </h1>
            <div class="job-location-wrapper-and-othre-info">
                <div class="job-location-wrapper">
                    <span class="location">Location</span>
                    <span>
                        <span> Mumbai, Maharashtra, India </span>
                        <span class="wokr-type"> Hybrid </span>
                    </span>
                </div>
                <div class="job-type-wrapper">
                    <span> Job type</span>
                    <span> Full-time</span>
                </div>
            </div>
        </div>
    </div>
[/vc_column][/vc_row][vc_row][vc_column]
    <div class="job-summary-wrapper">
        <h2>Role Overview</h2>
        <div class="summary-description">
            <p>We are seeking an experienced <strong>QA Lead</strong> to drive and implement QA strategies for our Low-Code/No-Code SaaS platform.</p>
        </div>
    </div>
[/vc_column][/vc_row][vc_row][vc_column]
    <div class="job-responsibilities-wrapper">
        <h2>Key Responsibilities</h2>
        <ul><li>Own the QA roadmap</li><li>Automate regression suites</li></ul>
    </div>
[/vc_column][/vc_row]`;

test("buildDronahqJd strips shortcode tokens and HTML, leaving clean prose", () => {
  const jd = buildDronahqJd(SAMPLE_CONTENT_HTML);
  assert.doesNotMatch(jd, /\[vc_/);
  assert.doesNotMatch(jd, /\[\/vc_/);
  assert.doesNotMatch(jd, /<[a-z]/i);
  assert.match(jd, /Role Overview/);
  assert.match(jd, /drive and implement QA strategies/);
  assert.match(jd, /Own the QA roadmap/);
  assert.match(jd, /Automate regression suites/);
});

test("buildDronahqJd returns empty string for missing/empty content", () => {
  assert.equal(buildDronahqJd(null), "");
  assert.equal(buildDronahqJd(undefined), "");
  assert.equal(buildDronahqJd(""), "");
});

test("dronahqLocationFromContent extracts the location from the job-header banner", () => {
  assert.equal(dronahqLocationFromContent(SAMPLE_CONTENT_HTML), "Mumbai, Maharashtra, India");
});

test("dronahqLocationFromContent returns null when the banner markup is absent", () => {
  assert.equal(dronahqLocationFromContent("<p>No location markup here.</p>"), null);
  assert.equal(dronahqLocationFromContent(null), null);
});

test("dronahqWorkTypeFromContent extracts the work-type span", () => {
  assert.equal(dronahqWorkTypeFromContent(SAMPLE_CONTENT_HTML), "Hybrid");
});

test("dronahqWorkTypeFromContent returns null when absent", () => {
  assert.equal(dronahqWorkTypeFromContent("<p>No work-type markup here.</p>"), null);
});

// --- normalizeDronahqJob ------------------------------------------------------

const baseJob: DronahqJob = {
  id: 35315,
  date: "2025-09-15T13:35:59",
  date_gmt: "2025-09-15T08:05:59",
  link: "https://www.dronahq.com/career/qa-lead/",
  title: { rendered: "QA Lead &#8211; SaaS" },
  content: { rendered: SAMPLE_CONTENT_HTML },
};

test("normalizeDronahqJob maps fields correctly", () => {
  const p = normalizeDronahqJob(company, baseJob);
  assert.equal(p.provider, "dronahq");
  assert.equal(p.externalId, "35315");
  assert.equal(p.jobTitle, "QA Lead – SaaS");
  assert.equal(p.jobUrl, "https://www.dronahq.com/career/qa-lead/");
  assert.equal(p.location, "Mumbai, Maharashtra, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Role Overview/);
  assert.doesNotMatch(p.jdText, /\[vc_/);
  assert.equal(p.postedAt, new Date("2025-09-15T08:05:59Z").toISOString());
});

test("normalizeDronahqJob coerces a numeric id to string externalId", () => {
  const p = normalizeDronahqJob(company, { ...baseJob, id: 12345 });
  assert.equal(p.externalId, "12345");
});

test("normalizeDronahqJob prefers date_gmt over the site-local date field", () => {
  const p = normalizeDronahqJob(company, { ...baseJob, date: "2099-01-01T00:00:00", date_gmt: "2025-09-15T08:05:59" });
  assert.equal(p.postedAt, new Date("2025-09-15T08:05:59Z").toISOString());
});

test("normalizeDronahqJob falls back to date when date_gmt is absent", () => {
  const p = normalizeDronahqJob(company, { ...baseJob, date_gmt: null, date: "2025-09-15T13:35:59" });
  assert.equal(p.postedAt, new Date(Date.parse("2025-09-15T13:35:59")).toISOString());
});

test("normalizeDronahqJob maps missing/unparseable dates to null postedAt", () => {
  const p = normalizeDronahqJob(company, { ...baseJob, date_gmt: null, date: null });
  assert.equal(p.postedAt, null);
});

test("normalizeDronahqJob maps missing location banner to null location", () => {
  const p = normalizeDronahqJob(company, { ...baseJob, content: { rendered: "<p>Plain body, no banner.</p>" } });
  assert.equal(p.location, null);
});

test("normalizeDronahqJob flags isRemote when the work-type span says Remote", () => {
  const remoteHtml = SAMPLE_CONTENT_HTML.replace(
    `<span class="wokr-type"> Hybrid </span>`,
    `<span class="wokr-type"> Remote </span>`,
  );
  const p = normalizeDronahqJob(company, { ...baseJob, content: { rendered: remoteHtml } });
  assert.equal(p.isRemote, true);
});

test("normalizeDronahqJob flags isRemote when the location text itself says Remote", () => {
  const remoteHtml = SAMPLE_CONTENT_HTML.replace(
    "Mumbai, Maharashtra, India",
    "Remote - India",
  );
  const p = normalizeDronahqJob(company, { ...baseJob, content: { rendered: remoteHtml } });
  assert.equal(p.isRemote, true);
});
