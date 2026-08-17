// src/ats/sonyresearch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSonyResearchOpenings,
  sonyResearchLocation,
  normalizeSonyResearchOpening,
  SONYRESEARCH_DEFAULT_LOCATION,
} from "../sonyresearch.js";
import type { SonyResearchOpening } from "../sonyresearch.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "sonyresearch", slug: "sonyresearch", name: "Sony Research India",
  careersUrl: "https://www.sonyresearchindia.com/careers/", tenantUrl: null, apiMeta: null,
};

// Each category renders a "no open positions" placeholder <h2> BEFORE the real opening's <h2>, proving "nearest preceding heading" isn't fooled by the placeholder.
const CONTENT_FIXTURE = `
<section><div><div><div><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">Internships</h2></div></div>
<div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">Thank you for your interest. There are no open positions at the moment, kindly keep an eye out for future opportunities.</h2></div></div>
</div></div></section>
<section><div><div><div><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">Multimodal AI Intern</h2></div></div>
<div class="elementor-widget-text-editor"><div class="elementor-widget-container">
<strong>Location:</strong> Bengaluru, India (Remote)<br>
<strong>Duration:</strong> 6 Months</div></div>
<div class="elementor-widget-button"><div class="elementor-widget-container"><div class="elementor-button-wrapper">
<a class="elementor-button elementor-button-link elementor-size-sm" href="https://www.linkedin.com/jobs/view/4434931409/" target="_blank">
<span class="elementor-button-content-wrapper"><span class="elementor-button-text">Apply Now</span></span></a>
</div></div></div>
</div></div></section>
<section><div><div><div><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">Full Time Positions</h2></div></div>
<div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">Thank you for your interest. There are no open positions at the moment, kindly keep an eye out for future opportunities.</h2></div></div>
</div></div></section>
<section><div><div><div><div class="elementor-widget-heading"><div class="elementor-widget-container">
<h2 class="elementor-heading-title elementor-size-default">LLM Engineer</h2></div></div>
<div class="elementor-widget-text-editor"><div class="elementor-widget-container">
<strong>Location:</strong> Bengaluru, India (Remote)<br>
<strong>Duration:</strong> 12 Months</div></div>
<div class="elementor-widget-button"><div class="elementor-widget-container"><div class="elementor-button-wrapper">
<a class="elementor-button elementor-button-link elementor-size-sm" href="https://www.linkedin.com/jobs/view/3967036882/" target="_blank">
<span class="elementor-button-content-wrapper"><span class="elementor-button-text">Apply Now</span></span></a>
</div></div></div>
</div></div></section>
`;

test("parseSonyResearchOpenings finds one opening per LinkedIn apply link, using the real title (not the 'no positions' placeholder)", () => {
  const openings = parseSonyResearchOpenings(CONTENT_FIXTURE);
  assert.equal(openings.length, 2);
  assert.deepEqual(openings.map((o) => o.title), ["Multimodal AI Intern", "LLM Engineer"]);
  assert.deepEqual(openings.map((o) => o.externalId), ["4434931409", "3967036882"]);
});

test("parseSonyResearchOpenings sets jobUrl to the LinkedIn link verbatim", () => {
  const [first] = parseSonyResearchOpenings(CONTENT_FIXTURE);
  assert(first);
  assert.equal(first.jobUrl, "https://www.linkedin.com/jobs/view/4434931409/");
});

test("parseSonyResearchOpenings jdText is the block's own text (title + Location + Duration), tags stripped", () => {
  const [first] = parseSonyResearchOpenings(CONTENT_FIXTURE);
  assert(first);
  assert.equal(first.jdText, "Multimodal AI Intern\nLocation: Bengaluru, India (Remote)\nDuration: 6 Months\nApply Now");
  assert.doesNotMatch(first.jdText, /<[^>]+>/);
});

test("parseSonyResearchOpenings returns [] when the page has no LinkedIn apply links", () => {
  assert.deepEqual(parseSonyResearchOpenings("<h2>No openings at the moment.</h2>"), []);
});

test("parseSonyResearchOpenings skips a link with no preceding heading at all", () => {
  const noHeading = `<a href="https://www.linkedin.com/jobs/view/111/">Apply Now</a>`;
  assert.deepEqual(parseSonyResearchOpenings(noHeading), []);
});

test("sonyResearchLocation pulls the city out of the block's Location: line", () => {
  assert.equal(sonyResearchLocation("LLM Engineer\nLocation: Bengaluru, India (Remote)\nDuration: 12 Months"), "Bengaluru, India (Remote)");
});

test("sonyResearchLocation falls back to the constant default when no Location: line is present", () => {
  assert.equal(sonyResearchLocation("Some Role\nDuration: 6 Months"), SONYRESEARCH_DEFAULT_LOCATION);
});

test("normalizeSonyResearchOpening maps fields and flags remote from the '(Remote)' location text", () => {
  const opening: SonyResearchOpening = {
    externalId: "4434931409",
    title: "Multimodal AI Intern",
    jobUrl: "https://www.linkedin.com/jobs/view/4434931409/",
    jdText: "Multimodal AI Intern\nLocation: Bengaluru, India (Remote)\nDuration: 6 Months\nApply Now",
  };
  const p = normalizeSonyResearchOpening(company, opening);
  assert.equal(p.provider, "sonyresearch");
  assert.equal(p.externalId, "4434931409");
  assert.equal(p.jobTitle, "Multimodal AI Intern");
  assert.equal(p.jobUrl, "https://www.linkedin.com/jobs/view/4434931409/");
  assert.equal(p.location, "Bengaluru, India (Remote)");
  assert.equal(p.isRemote, true);
  assert.equal(p.jdText, opening.jdText);
  assert.equal(p.postedAt, null);
});

test("normalizeSonyResearchOpening falls back to the constant location and isRemote=false without a Location: line", () => {
  const opening: SonyResearchOpening = {
    externalId: "1",
    title: "Some Role",
    jobUrl: "https://www.linkedin.com/jobs/view/1/",
    jdText: "Some Role\nDuration: 6 Months",
  };
  const p = normalizeSonyResearchOpening(company, opening);
  assert.equal(p.location, SONYRESEARCH_DEFAULT_LOCATION);
  assert.equal(p.isRemote, false);
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("sonyresearchAdapter.fetchJd returns the posting's own jdText without any network call", async () => {
  const { sonyresearchAdapter } = await import("../sonyresearch.js");
  let fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    throw new Error("fetchJd must not hit the network when jdText is already populated");
  });
  try {
    const posting = normalizeSonyResearchOpening(company, {
      externalId: "1",
      title: "Some Role",
      jobUrl: "https://www.linkedin.com/jobs/view/1/",
      jdText: "Some Role\nLocation: Bengaluru, India\nDuration: 6 Months",
    });
    const { fetchJd } = sonyresearchAdapter;
    assert(fetchJd);
    const jd = await fetchJd(company, posting);
    assert.equal(jd, posting.jdText);
    assert.equal(fetchCalled, false);
  } finally {
    restoreFetch();
  }
});

test("sonyresearchAdapter.fetchJd re-derives from the careers page (never LinkedIn) when jdText is empty", async () => {
  const { sonyresearchAdapter } = await import("../sonyresearch.js");
  const urlsHit: string[] = [];
  stubFetch(async (input) => {
    const url = String(input);
    urlsHit.push(url);
    if (url.includes("linkedin.com")) throw new Error("must never fetch LinkedIn");
    return new Response(JSON.stringify([{ content: { rendered: CONTENT_FIXTURE } }]), { status: 200 });
  });
  try {
    const posting = normalizeSonyResearchOpening(company, {
      externalId: "4434931409",
      title: "Multimodal AI Intern",
      jobUrl: "https://www.linkedin.com/jobs/view/4434931409/",
      jdText: "",
    });
    const { fetchJd } = sonyresearchAdapter;
    assert(fetchJd);
    const jd = await fetchJd(company, posting);
    assert.match(jd, /Multimodal AI Intern/);
    assert.ok(urlsHit.every((u) => !u.includes("linkedin.com")));
  } finally {
    restoreFetch();
  }
});
