// src/ats/teamtailor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  teamtailorJobsUrl,
  parseTeamtailorList,
  teamtailorJdFromHtml,
} from "./teamtailor.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "teamtailor", slug: "73strings", name: "73 Strings",
  careersUrl: "https://73strings.teamtailor.com/jobs", tenantUrl: null, apiMeta: null,
};

// Layout variant A ("company-links" list, live-captured from 73strings and
// veoneerin 2026-07-11): <li class="w-full"> with a bare title anchor and a
// sibling meta div of dept · location · workplace spans.
const listHtmlA = `<html><body>
    <ul id="jobs_list_container" class="company-links">
        <li class="w-full">
  <div class="relative flex flex-col items-center py-6 text-center">
    <a class="@sm:line-clamp-2 flex" data-turbo="false" href="https://73strings.teamtailor.com/jobs/7093222-senior-software-engineer-backend">
      <span class="absolute inset-0"></span>
      Senior Software Engineer - Backend
</a>
    <div class="mt-1 text-md">
<span>Technology</span>
  <span class="mx-[2px]">&middot;</span>
    <span>Bangalore</span>
</div>
</div>
    <span class="block w-full h-px bg-gradient-block-base-border"></span>
</li>
        <li class="w-full">
  <div class="relative flex flex-col items-center py-6 text-center">
    <a class="@sm:line-clamp-2 flex" data-turbo="false" href="https://73strings.teamtailor.com/jobs/8041722-senior-data-product-manager">
      <span class="absolute inset-0"></span>
      Senior Data Product Manager
</a>
    <div class="mt-1 text-md">
<span>Product</span>
  <span class="mx-[2px]">&middot;</span>
    <span>New York</span>
    <span class="mx-[2px]">&middot;</span>
  <span class="inline-flex items-center gap-x-2">
    Hybrid
    <i class="w-4 h-5 text-xs fas fa-wifi"></i>
</span></div>
</div>
</li>
        <li class="w-full">
  <div class="relative flex flex-col items-center py-6 text-center">
    <a class="@sm:line-clamp-2 flex" data-turbo="false" href="https://73strings.teamtailor.com/jobs/7763460-project-manager-remote">
      <span class="absolute inset-0"></span>
      Project Manager
</a>
    <div class="mt-1 text-md">
    <span>Remote</span>
</div>
</div>
</li>
    </ul>
</body></html>`;

// Layout variant B ("block-grid" cards, live-captured from corporater and
// storytel 2026-07-11): title lives in a span[title] INSIDE the anchor, the
// meta div is also inside the anchor, and the job link may point at a custom
// domain (jobs.storytel.com) instead of the teamtailor.com host.
const listHtmlB = `<html><body>
    <ul class="block-grid" id="jobs_list_container">
        <li class="group border rounded block-grid-item">
  <a class="min-h-[11.25rem] h-full w-full p-4 flex" data-turbo="false" href="https://corporater.teamtailor.com/jobs/6635737-managed-service-consultants">
    <span class="text-block-base-link company-link-style" title="Managed Service Consultants">
      Managed Service Consultants
    </span>
    <div class="mt-1 text-md">
    <span>Corporater Asia, Bangalore, India</span>
</div>
</a></li>
        <li class="group border rounded block-grid-item">
  <a class="min-h-[11.25rem] h-full w-full p-4 flex" data-turbo="false" href="https://jobs.storytel.com/jobs/7969316-software-engineer-ai-agents">
    <span class="text-block-base-link company-link-style" title="Software Engineer - AI Agents">
      Software Engineer - AI Agents
    </span>
    <div class="mt-1 text-md">
<span>Tech</span>
  <span class="mx-[2px]">&middot;</span>
    <span>Stockholm</span>
</div>
</a></li>
    </ul>
</body></html>`;

// Job detail page: JSON-LD JobPosting island whose description is
// entity-encoded HTML (live shape from 73strings job 7093222).
const detailHtml = `<html><head>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting","title":"Senior Software Engineer - Backend","datePosted":"2026-01-22T12:38:59+05:30","description":"&lt;p&gt;&lt;strong&gt;OVERVIEW:&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;73 Strings is an innovative platform &amp;amp; valuation suite.&lt;/p&gt;","hiringOrganization":{"@type":"Organization","name":"73 Strings"},"jobLocation":[{"@type":"Place","address":{"addressLocality":"Bengaluru","addressCountry":"IN","@type":"PostalAddress"}}]}</script>
</head><body><main>
<div class="prose prose-block font-company-body"><p><strong>OVERVIEW:</strong></p><p>73 Strings is an innovative platform &amp; valuation suite.</p></div>
</main></body></html>`;

test("teamtailorJobsUrl builds the paged board URL from the careers URL origin", () => {
  assert.equal(teamtailorJobsUrl(company, 1), "https://73strings.teamtailor.com/jobs?page=1");
  assert.equal(teamtailorJobsUrl(company, 3), "https://73strings.teamtailor.com/jobs?page=3");
});

test("teamtailorJobsUrl prefers tenantUrl origin when set", () => {
  const c: AdapterCompany = { ...company, tenantUrl: "https://veoneerin.teamtailor.com" };
  assert.equal(teamtailorJobsUrl(c, 2), "https://veoneerin.teamtailor.com/jobs?page=2");
});

test("parseTeamtailorList (variant A) maps title, id, url, dept-then-location spans", () => {
  const items = parseTeamtailorList(company, listHtmlA);
  assert.ok(items);
  assert.equal(items.length, 3);
  const [a, b, c] = items;
  assert.equal(a?.provider, "teamtailor");
  assert.equal(a?.externalId, "7093222");
  assert.equal(a?.jobTitle, "Senior Software Engineer - Backend");
  assert.equal(a?.jobUrl, "https://73strings.teamtailor.com/jobs/7093222-senior-software-engineer-backend");
  assert.equal(a?.location, "Bangalore");
  assert.equal(a?.isRemote, false);
  assert.equal(a?.companySlug, "73strings");
  assert.equal(a?.jdText, "");
  // dept + location + Hybrid workplace chip: location is the LAST non-workplace span
  assert.equal(b?.externalId, "8041722");
  assert.equal(b?.location, "New York");
  assert.equal(b?.isRemote, false);
  // single "Remote" span is a workplace marker, not a location
  assert.equal(c?.externalId, "7763460");
  assert.equal(c?.location, null);
  assert.equal(c?.isRemote, true);
});

test("parseTeamtailorList (variant B) reads span[title] titles and custom-domain hrefs", () => {
  const items = parseTeamtailorList(company, listHtmlB);
  assert.ok(items);
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a?.jobTitle, "Managed Service Consultants");
  assert.equal(a?.externalId, "6635737");
  assert.equal(a?.location, "Corporater Asia, Bangalore, India");
  assert.equal(b?.jobTitle, "Software Engineer - AI Agents");
  assert.equal(b?.externalId, "7969316");
  assert.equal(b?.jobUrl, "https://jobs.storytel.com/jobs/7969316-software-engineer-ai-agents");
  assert.equal(b?.location, "Stockholm");
});

test("parseTeamtailorList returns null when the board container is missing, [] when it is empty", () => {
  assert.equal(parseTeamtailorList(company, "<html><body>no board here</body></html>"), null);
  const empty = parseTeamtailorList(company, `<ul id="jobs_list_container"></ul>`);
  assert.ok(empty);
  assert.equal(empty.length, 0);
});

test("teamtailorJdFromHtml falls back to prose when the ld+json has no JobPosting (Organization block, malformed block)", () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>
<script type="application/ld+json">not json</script>`;
  assert.equal(teamtailorJdFromHtml(html), "");
});

test("teamtailorJdFromHtml decodes the entity-encoded JSON-LD description to plain text", () => {
  const jd = teamtailorJdFromHtml(detailHtml);
  assert.match(jd, /OVERVIEW:/);
  assert.match(jd, /innovative platform & valuation suite/);
  assert.doesNotMatch(jd, /&lt;|<p>|<strong>/);
});

test("teamtailorJdFromHtml falls back to the server-rendered .prose block without JSON-LD", () => {
  const noLd = detailHtml.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
  const jd = teamtailorJdFromHtml(noLd);
  assert.match(jd, /innovative platform & valuation suite/);
  assert.doesNotMatch(jd, /<p>/);
});
