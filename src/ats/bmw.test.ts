// src/ats/bmw.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBmwFragment, extractBmwJd, bmwFragmentPageUrl } from "./bmw.js";
import { at } from "./test-helpers.js";

// Trimmed from the live India fragment (2026-07-18).
const FRAGMENT = `
<div class="grp-jobfinder__table" data-counter-text="We found one vacancy in India." data-counter="1">
  <div class="grp-jobfinder__wrapper" data-job-id="184317">
    <button class="grp-jobfinder__favorite"></button>
    <a class="grp-popup-link-js grp-jobfinder__link-jobdescription" href="/in/en/jobfinder/job-description-copy.184317.html" aria-label="Customer Support Technical Manager">
      <div class="grp-jobfinder-cell-refno" data-job-title="Customer Support Technical Manager" data-job-location="Gurugram" data-job-legal-entity="BMW India Pvt. Ltd." data-job-field="Aftersales Service &amp; Warranty" data-posting-date="20260425" data-job-type="General">184317</div>
    </a>
  </div>
</div>`;

test("parseBmwFragment reads the India total and structured tile fields", () => {
  const { tiles, total } = parseBmwFragment(FRAGMENT, "https://www.bmwgroup.jobs");
  assert.equal(total, 1);
  assert.equal(tiles.length, 1);
  const t = at(tiles, 0);
  assert.equal(t.externalId, "184317");
  assert.equal(t.jobTitle, "Customer Support Technical Manager");
  assert.equal(t.location, "Gurugram");
  assert.equal(t.legalEntity, "BMW India Pvt. Ltd.");
  assert.equal(t.detailUrl, "https://www.bmwgroup.jobs/in/en/jobfinder/job-description-copy.184317.html");
  assert.equal(t.postedAt, "2026-04-25");
});

test("parseBmwFragment yields no tiles for an empty table", () => {
  const { tiles, total } = parseBmwFragment(`<div class="grp-jobfinder__table" data-counter="0"></div>`, "https://www.bmwgroup.jobs");
  assert.equal(total, 0);
  assert.equal(tiles.length, 0);
});

test("extractBmwJd pulls the jobdescription content, falls back to main", () => {
  const jd = extractBmwJd(`<div class="grp-jobdescription__content"><p>Own aftersales support.</p></div>`);
  assert.match(jd, /Own aftersales support/);
  assert.match(extractBmwJd(`<main><p>fallback</p></main>`), /fallback/);
});

test("bmwFragmentPageUrl sets rowIndex, preserving the captured filter", () => {
  const u = new URL(
    bmwFragmentPageUrl(
      "https://www.bmwgroup.jobs/in/en/jobs/_jcr_content/main/x/jobfinder30.jobfinder_table.content.html?filterSearch=location_IN&rowIndex=0&blockCount=5",
      10,
    ),
  );
  assert.equal(u.searchParams.get("rowIndex"), "10");
  assert.equal(u.searchParams.get("filterSearch"), "location_IN");
  assert.equal(u.searchParams.get("blockCount"), "5");
});
