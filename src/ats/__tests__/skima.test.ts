// src/ats/skima.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  skimaPageUrl,
  parseSkimaListingHtml,
  normalizeSkimaItem,
  extractSkimaJd,
} from "../skima.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "skima",
  slug: "nykaa",
  name: "Nykaa",
  careersUrl: "https://careers.nykaa.com/",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed from the live Nykaa board: one full card, an Apply anchor sharing the title link's uuid, and the counter.
const LISTING_HTML = `
<html><body>
<div class="divide-y-[1px] rounded-md border border-offset-background">
  <div class="flex flex-col space-y-3 border-offset-background p-5 md:flex-row">
    <div class="w-full">
      <a href="/74e803d6-59c3-4430-a10d-9c8199a170af" class="text-lg font-semibold text-primary"> HR Operation Executive (Offroll) </a>
      <p class="text-sm">Minimum 1.0 of experience</p>
      <div class="flex flex-wrap items-center space-x-3">
        <span class="break-all text-sm"> Mumbai </span>
        <div class="h-[6px] w-[6px] rounded-full"></div><span class="break-all text-sm"> In Office </span>
        <div class="h-[6px] w-[6px] rounded-full"></div><span class="break-all text-sm"> Full Time </span>
      </div>
    </div>
    <div class="flex justify-end">
      <a href="/74e803d6-59c3-4430-a10d-9c8199a170af" class="inline-flex items-center bg-primary"> <span></span> </a>
    </div>
  </div>
  <div class="flex flex-col space-y-3 border-offset-background p-5 md:flex-row">
    <div class="w-full">
      <a href="/AB783FC3-F66C-4E73-8CD7-E3E272F3E4DB" class="text-lg font-semibold text-primary"> Senior Supply Chain Planner - Nykaa Fashion - Mumbai </a>
      <div class="flex flex-wrap items-center space-x-3">
        <span class="break-all text-sm"> Remote </span>
        <div class="h-[6px] w-[6px] rounded-full"></div><span class="break-all text-sm"> Full Time </span>
      </div>
    </div>
  </div>
</div>
<p>Showing 10 of 22 - Jobs</p>
</body></html>`;

const DETAIL_HTML = `
<html><body><main>
<h1 class="text-2xl font-semibold text-primary">HR Operation Executive</h1>
<div class="job-description-panel w-full break-words font-normal">
  <p>About the role.</p>
  <ul><li>Do HR ops</li><li>Own onboarding</li></ul>
</div>
</main></body></html>`;

test("skimaPageUrl returns the bare URL for page 1 and ?page=N beyond", () => {
  assert.equal(skimaPageUrl("https://careers.nykaa.com", 1), "https://careers.nykaa.com");
  assert.equal(new URL(skimaPageUrl("https://careers.nykaa.com", 3)).searchParams.get("page"), "3");
});

test("parseSkimaListingHtml extracts title cards, skips text-less Apply anchors, reads total", () => {
  const page = parseSkimaListingHtml(LISTING_HTML, "https://careers.nykaa.com");
  assert.equal(page.total, 22);
  assert.equal(page.items.length, 2);

  const first = at(page.items, 0);
  assert.equal(first.externalId, "74e803d6-59c3-4430-a10d-9c8199a170af");
  assert.equal(first.jobTitle, "HR Operation Executive (Offroll)");
  assert.equal(first.jobUrl, "https://careers.nykaa.com/74e803d6-59c3-4430-a10d-9c8199a170af");
  assert.equal(first.location, "Mumbai");
  assert.equal(first.isRemote, false);

  const second = at(page.items, 1);
  assert.equal(second.externalId, "ab783fc3-f66c-4e73-8cd7-e3e272f3e4db"); // lowercased
  assert.equal(second.isRemote, true);
});

test("parseSkimaListingHtml returns null total when the counter is absent", () => {
  const page = parseSkimaListingHtml("<html><body></body></html>", "https://careers.nykaa.com");
  assert.equal(page.total, null);
  assert.equal(page.items.length, 0);
});

test("normalizeSkimaItem maps fields onto NormalizedPosting", () => {
  const page = parseSkimaListingHtml(LISTING_HTML, "https://careers.nykaa.com");
  const p = normalizeSkimaItem(company, at(page.items, 0));
  assert.equal(p.provider, "skima");
  assert.equal(p.companySlug, "nykaa");
  assert.equal(p.jobTitle, "HR Operation Executive (Offroll)");
  assert.equal(p.location, "Mumbai");
  assert.equal(p.jdText, "");
});

test("extractSkimaJd pulls the job-description-panel text", () => {
  const jd = extractSkimaJd(DETAIL_HTML);
  assert.match(jd, /About the role/);
  assert.match(jd, /Own onboarding/);
});

test("extractSkimaJd falls back to <main> when the panel is missing", () => {
  const jd = extractSkimaJd("<html><body><main><p>fallback body</p></main></body></html>");
  assert.match(jd, /fallback body/);
});
