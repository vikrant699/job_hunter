// src/ats/htmlboard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHtmlBoardRendered,
  htmlboardAdapter,
  htmlBoardConfig,
  htmlBoardExternalId,
  parseHtmlBoardListing,
  extractHtmlBoardJd,
} from "./htmlboard.js";
import type { AdapterCompany } from "../types.js";
import { at, fetchSequence, htmlResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";

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
  const item0 = at(items, 0);
  assert.equal(item0.jobTitle, "Senior Engineer");
  assert.equal(item0.jobUrl, "https://acme.example/careers/senior-engineer");
  assert.equal(item0.location, "Noida, India");
  assert.equal(item0.jdText, "");
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
  const item0 = at(items, 0);
  const item1 = at(items, 1);
  assert.equal(item0.jobTitle, "Solar Design Lead");
  assert.match(item0.jdText, /Own PV layouts/);
  assert.equal(item0.location, "Mumbai");
  // Second block has no Location line -> fixedLocation fallback.
  assert.equal(item1.location, "India");
  // No links on this board -> title-slug ids.
  assert.equal(item0.externalId, "solar-design-lead");
});

// --- boardSelector: dead page vs empty board ----------------------------------

// A LIVE board with every role filled: the wrapper and the vendor's own empty
// state are still there, only the cards are gone. This must keep returning [].
const EMPTY_BOARD_HTML = `
<html><body>
  <section id="jobs">
    <div class="filter-bar"><input type="search" placeholder="Search roles" /></div>
    <ul class="job-list"></ul>
    <p class="no-roles">No open roles right now. Check back soon.</p>
  </section>
</body></html>`;

// What a lapsed careers domain actually serves at HTTP 200 — a registrar park
// page. No board wrapper, and no items either, so it used to parse as "healthy,
// nothing open" forever.
const PARKED_HTML = `
<html><head><title>acme.example</title></head><body>
  <h1>acme.example</h1>
  <p>This domain is for sale. Enquire within.</p>
  <div class="ad-slot"></div>
</body></html>`;

const boardMeta = { itemSelector: "li.card", titleSelector: "h3.roleTitle", boardSelector: "#jobs" };

test("assertHtmlBoardRendered throws when a page has no items and no board marker", () => {
  const cfg = htmlBoardConfig(company(boardMeta));
  assert.throws(() => assertHtmlBoardRendered(PARKED_HTML, cfg, 0, "acme"), /board did not render/);
});

test("assertHtmlBoardRendered accepts a genuinely empty board that still rendered", () => {
  const cfg = htmlBoardConfig(company(boardMeta));
  assert.doesNotThrow(() => assertHtmlBoardRendered(EMPTY_BOARD_HTML, cfg, 0, "acme"));
});

test("assertHtmlBoardRendered never fires on a page that produced items", () => {
  // A board that yielded rows is live whatever its markup calls things, so a
  // stale or mistyped boardSelector can never fail it.
  const cfg = htmlBoardConfig(company({ ...boardMeta, boardSelector: "#selector-that-is-gone" }));
  assert.doesNotThrow(() => assertHtmlBoardRendered(LINKED_HTML, cfg, 2, "acme"));
});

test("assertHtmlBoardRendered is inert for the rows that configure no boardSelector", () => {
  // The 34 pre-existing rows must behave exactly as before opting in.
  const cfg = htmlBoardConfig(company({ itemSelector: "li.card" }));
  assert.equal(cfg.boardSelector, null);
  assert.doesNotThrow(() => assertHtmlBoardRendered(PARKED_HTML, cfg, 0, "acme"));
});

test("listPostings throws on a parked page and returns [] for an empty board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(PARKED_HTML)));
  await assert.rejects(() => htmlboardAdapter.listPostings(company(boardMeta)), /board did not render/);

  stubFetch(t, fetchSequence(() => htmlResponse(EMPTY_BOARD_HTML)));
  assert.deepEqual(await htmlboardAdapter.listPostings(company(boardMeta)), []);
});

test("listPostings still parses a populated board unchanged with boardSelector set", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(LINKED_HTML)));
  const postings = await htmlboardAdapter.listPostings(company({ ...boardMeta, boardSelector: "ul" }));
  assert.equal(postings.length, 2);
  assert.equal(at(postings, 0).jobTitle, "Senior Engineer");
});

test("a boardSelector-less row is unaffected by a page with no board at all", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(PARKED_HTML)));
  assert.deepEqual(await htmlboardAdapter.listPostings(company({ itemSelector: "li.card" })), []);
});

test("a paged board is only audited on page 1", async (t) => {
  // Page 2 is where a pager runs out; whatever it serves must end the loop
  // quietly rather than quarantine a board that already produced postings.
  stubFetch(t, fetchSequence(() => htmlResponse(LINKED_HTML), () => htmlResponse(PARKED_HTML)));
  const postings = await htmlboardAdapter.listPostings(
    company({ ...boardMeta, boardSelector: "ul", pageParam: "page" }),
  );
  assert.equal(postings.length, 2);
});

test("the dead-page error is charged to the company, not written off as infrastructure", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(PARKED_HTML)));
  const err = await htmlboardAdapter
    .listPostings(company(boardMeta))
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("extractHtmlBoardJd honors detailJdSelector and falls back to main", () => {
  const cfg = htmlBoardConfig(company({ itemSelector: ".x", detailJdSelector: ".jd" }));
  assert.match(extractHtmlBoardJd(`<div class="jd"><p>Body A</p></div>`, cfg), /Body A/);
  assert.match(
    extractHtmlBoardJd(`<main><p>Fallback body</p></main>`, cfg),
    /Fallback body/,
  );
});
