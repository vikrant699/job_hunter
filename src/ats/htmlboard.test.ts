// src/ats/htmlboard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlBoardConfig,
  htmlBoardExternalId,
  parseHtmlBoardListing,
  extractHtmlBoardJd,
} from "./htmlboard.js";
import type { AdapterCompany } from "../types.js";

function company(apiMeta: Record<string, string>): AdapterCompany {
  return {
    provider: "htmlboard",
    slug: "acme",
    name: "Acme",
    careersUrl: "https://acme.example/careers",
    tenantUrl: null,
    apiMeta,
  };
}

// Detail-link board (like doceree/scaler): cards link out to a JD page.
const LINKED_HTML = `
<html><body><ul>
  <li class="card">
    <a href="/careers/senior-engineer"><h3 class="roleTitle">Senior Engineer</h3></a>
    <span class="loc">Noida, India</span>
  </li>
  <li class="card">
    <a href="/careers/pm"><h3 class="roleTitle">Product Manager</h3></a>
    <span class="loc">Remote</span>
  </li>
  <li class="card"><a href="/careers/senior-engineer"><h3 class="roleTitle">Senior Engineer</h3></a></li>
</ul></body></html>`;

// Inline-JD board (like cashkaro/mahindra-susten): each block carries its JD.
const INLINE_HTML = `
<html><body>
  <div class="tab-pane" id="career-pills-1">
    <h4>Solar Design Lead</h4>
    <p>Job ID: 1402 | Published Date: 2026-07-01</p>
    <div class="job_description"><p>Own PV layouts.</p><strong>Location :-</strong> Mumbai</div>
  </div>
  <div class="tab-pane" id="career-pills-2">
    <h4>Site Supervisor</h4>
    <div class="job_description"><p>Run the site.</p></div>
  </div>
</body></html>`;

test("htmlBoardConfig requires itemSelector", () => {
  assert.throws(() => htmlBoardConfig(company({})), /itemSelector/);
});

test("htmlBoardConfig defaults listUrl to careersUrl and parses regex", () => {
  const cfg = htmlBoardConfig(company({ itemSelector: ".card", locationRegex: "Location\\s*:?-?\\s*([^\\n|]+)" }));
  assert.equal(cfg.listUrl, "https://acme.example/careers");
  assert.ok(cfg.locationRegex instanceof RegExp);
});

test("htmlBoardExternalId prefers link path, falls back to title slug", () => {
  assert.equal(htmlBoardExternalId("https://a.example/careers/x?id=2", "T"), "/careers/x?id=2");
  assert.equal(htmlBoardExternalId(null, "Senior Engineer (Backend)"), "senior-engineer-backend");
});

test("parseHtmlBoardListing extracts linked cards with dedup", () => {
  const cfg = htmlBoardConfig(company({
    itemSelector: "li.card",
    titleSelector: "h3.roleTitle",
    locationSelector: ".loc",
  }));
  const items = parseHtmlBoardListing(LINKED_HTML, cfg);
  assert.equal(items.length, 2); // duplicate senior-engineer dropped
  assert.equal(items[0]!.jobTitle, "Senior Engineer");
  assert.equal(items[0]!.jobUrl, "https://acme.example/careers/senior-engineer");
  assert.equal(items[0]!.location, "Noida, India");
  assert.equal(items[0]!.jdText, "");
});

test("parseHtmlBoardListing extracts inline-JD blocks with location regex", () => {
  const cfg = htmlBoardConfig(company({
    itemSelector: "div.tab-pane",
    titleSelector: "h4",
    jdSelector: ".job_description",
    locationRegex: "Location\\s*:?-?\\s*([^\\n|]+)",
    fixedLocation: "India",
  }));
  const items = parseHtmlBoardListing(INLINE_HTML, cfg);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.jobTitle, "Solar Design Lead");
  assert.match(items[0]!.jdText, /Own PV layouts/);
  assert.equal(items[0]!.location, "Mumbai");
  // Second block has no Location line -> fixedLocation fallback.
  assert.equal(items[1]!.location, "India");
  // No links on this board -> title-slug ids.
  assert.equal(items[0]!.externalId, "solar-design-lead");
});

test("extractHtmlBoardJd honors detailJdSelector and falls back to main", () => {
  const cfg = htmlBoardConfig(company({ itemSelector: ".x", detailJdSelector: ".jd" }));
  assert.match(extractHtmlBoardJd(`<div class="jd"><p>Body A</p></div>`, cfg), /Body A/);
  assert.match(
    extractHtmlBoardJd(`<main><p>Fallback body</p></main>`, cfg),
    /Fallback body/,
  );
});
