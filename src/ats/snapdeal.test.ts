// src/ats/snapdeal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSnapdealOpenings,
  snapdealExternalId,
  normalizeSnapdealOpening,
  fetchSnapdealCareersHtml,
  SNAPDEAL_CAREERS_URL,
  SNAPDEAL_LOCATION,
} from "./snapdeal.js";
import type { SnapdealOpening } from "./snapdeal.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "snapdeal", slug: "snapdeal", name: "Snapdeal",
  careersUrl: SNAPDEAL_CAREERS_URL, tenantUrl: null, apiMeta: null,
};

// Excerpt of the real blog.snapdeal.com/index.php/wp-json/wp/v2/pages/632
// content.rendered body (captured 2026-07-12) — intro copy, an ordinary
// opening, two openings whose "Title/Role:" line is split across nested
// <strong> tags (mirrors the live "Fullstack" and "Account Manager – Cross
// Border Trade" entries), one with a literal non-breaking space after the
// colon (mirrors the live "Openstack Engineer" entry), and the closing
// boilerplate paragraphs (blank, email-us, culture blurb).
const CONTENT_FIXTURE = `<p>Are you keen on being a part of a team dedicated to creating life-changing experiences for buyers and sellers across India?</p>
<p>Check out the open positions for our Gurugram office below. Share your CV with us ta@snapdeal.com with the job title in the subject line.</p>
<p>&nbsp;</p>
<p><strong>Title/Role: iOS</strong><br />
Skill Set (Area of Expertise): Objective C and Swift<br />
Experience: 3 yrs- 10 yrs</p>
<p><strong>Title/Role: </strong>Fullstack<br />
Skill Set (Area of Expertise): Front end and backend (Should know React)<br />
Experience: 5 yrs- 11 yrs</p>
<p><strong>Title/Role: Account Manager &#8211; </strong>Cross Border<strong> Trade</strong><br />
Skill Set (Area of Expertise): Mandarin, account management, vendor engagement<br />
Experience: 2 yrs &#8211; 5 yrs</p>
<p><strong>Title/Role: </strong>Openstack<strong> Engineer</strong><br />
Skill Set (Area of Expertise): Openstack, Python Scripting, Java and Linux<br />
Experience: 3 yrs &#8211; 10 yrs</p>
<p>&nbsp;</p>
<p>Share your CV with us ta@snapdeal.com</p>
<p>Curious about our culture? Check out <a href="http://blog.snapdeal.com/index.php/category/life-at-snapdeal/">life at Snapdeal</a> and read the stories of our rockstars.</p>`;

test("parseSnapdealOpenings extracts one opening per Title/Role paragraph, skipping boilerplate", () => {
  const openings = parseSnapdealOpenings(CONTENT_FIXTURE);
  assert.equal(openings.length, 4);
  assert.deepEqual(
    openings.map((o) => o.title),
    ["iOS", "Fullstack", "Account Manager – Cross Border Trade", "Openstack Engineer"],
  );
});

test("parseSnapdealOpenings keeps the whole block (skill set + experience) as jdText", () => {
  const [ios] = parseSnapdealOpenings(CONTENT_FIXTURE);
  assert.match(ios!.jdText, /Title\/Role: iOS/);
  assert.match(ios!.jdText, /Skill Set \(Area of Expertise\): Objective C and Swift/);
  assert.match(ios!.jdText, /Experience: 3 yrs- 10 yrs/);
  assert.doesNotMatch(ios!.jdText, /<p>|<strong>/);
});

test("parseSnapdealOpenings handles a Title/Role split mid-<strong> tag (live 'Fullstack' shape)", () => {
  const openings = parseSnapdealOpenings(CONTENT_FIXTURE);
  const fullstack = openings.find((o) => o.title === "Fullstack");
  assert.ok(fullstack);
  assert.match(fullstack!.jdText, /Front end and backend/);
});

test("parseSnapdealOpenings handles a Title/Role split across two <strong> runs (live 'Account Manager' shape)", () => {
  const openings = parseSnapdealOpenings(CONTENT_FIXTURE);
  const am = openings.find((o) => o.title === "Account Manager – Cross Border Trade");
  assert.ok(am);
  assert.match(am!.jdText, /Mandarin, account management/);
});

test("parseSnapdealOpenings trims a literal non-breaking space after the marker (live 'Openstack Engineer' shape)", () => {
  const openings = parseSnapdealOpenings(CONTENT_FIXTURE);
  const os = openings.find((o) => o.title === "Openstack Engineer");
  assert.ok(os);
});

test("parseSnapdealOpenings returns [] when the page has no Title/Role blocks at all", () => {
  const openings = parseSnapdealOpenings("<p>Nothing open right now.</p>");
  assert.deepEqual(openings, []);
});

test("snapdealExternalId kebab-cases the title", () => {
  assert.equal(snapdealExternalId("Account Manager – Cross Border Trade"), "account-manager-cross-border-trade");
  assert.equal(snapdealExternalId("AM/DM – Employee Engagement (HR)"), "am-dm-employee-engagement-hr");
});

test("normalizeSnapdealOpening maps to the constant careers URL and Gurugram location", () => {
  const opening: SnapdealOpening = {
    title: "iOS",
    jdText: "Title/Role: iOS\nSkill Set (Area of Expertise): Objective C and Swift\nExperience: 3 yrs- 10 yrs",
  };
  const p = normalizeSnapdealOpening(company, opening);
  assert.equal(p.provider, "snapdeal");
  assert.equal(p.externalId, "ios");
  assert.equal(p.jobTitle, "iOS");
  assert.equal(p.jobUrl, SNAPDEAL_CAREERS_URL);
  assert.equal(p.location, SNAPDEAL_LOCATION);
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, opening.jdText);
  assert.equal(p.postedAt, null);
});

// --- fetchSnapdealCareersHtml: page-id resolution (404 fallback + throw) ---

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("fetchSnapdealCareersHtml returns page 632's content when it resolves normally", async () => {
  stubFetch(async (input) => {
    const url = String(input);
    assert.match(url, /\/pages\/632$/);
    return new Response(JSON.stringify({ content: { rendered: "<p>Title/Role: iOS</p>" } }), { status: 200 });
  });
  try {
    const html = await fetchSnapdealCareersHtml();
    assert.equal(html, "<p>Title/Role: iOS</p>");
  } finally {
    restoreFetch();
  }
});

test("fetchSnapdealCareersHtml falls back to the search API when 632 404s, then fetches the hit's page id", async () => {
  const urlsHit: string[] = [];
  stubFetch(async (input) => {
    const url = String(input);
    urlsHit.push(url);
    if (url.includes("/pages/632")) return new Response("not found", { status: 404 });
    if (url.includes("/search")) {
      return new Response(
        JSON.stringify([{ id: 999, subtype: "page" }, { id: 1, subtype: "post" }]),
        { status: 200 },
      );
    }
    if (url.includes("/pages/999")) {
      return new Response(JSON.stringify({ content: { rendered: "<p>Title/Role: Backend</p>" } }), { status: 200 });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
  try {
    const html = await fetchSnapdealCareersHtml();
    assert.equal(html, "<p>Title/Role: Backend</p>");
    assert.ok(urlsHit.some((u) => u.includes("/pages/632")));
    assert.ok(urlsHit.some((u) => u.includes("/search")));
    assert.ok(urlsHit.some((u) => u.includes("/pages/999")));
  } finally {
    restoreFetch();
  }
});

test("fetchSnapdealCareersHtml throws when 632 404s and the search fallback has no page-type hit", async () => {
  stubFetch(async (input) => {
    const url = String(input);
    if (url.includes("/pages/632")) return new Response("not found", { status: 404 });
    if (url.includes("/search")) return new Response(JSON.stringify([{ id: 1, subtype: "post" }]), { status: 200 });
    throw new Error(`unexpected URL in test: ${url}`);
  });
  try {
    await assert.rejects(fetchSnapdealCareersHtml(), /careers page not found/);
  } finally {
    restoreFetch();
  }
});

test("fetchSnapdealCareersHtml propagates a non-404 error without trying the search fallback", async () => {
  let searchCalled = false;
  stubFetch(async (input) => {
    const url = String(input);
    if (url.includes("/pages/632")) return new Response("server error", { status: 500 });
    if (url.includes("/search")) searchCalled = true;
    return new Response("[]", { status: 200 });
  });
  try {
    await assert.rejects(fetchSnapdealCareersHtml(), /HTTP 500/);
    assert.equal(searchCalled, false);
  } finally {
    restoreFetch();
  }
});
