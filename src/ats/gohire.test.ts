// src/ats/gohire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gohireBoardUrl,
  gohireExternalId,
  parseGohireListPage,
  gohireAdapter,
} from "./gohire.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";

const company: AdapterCompany = {
  provider: "gohire",
  slug: "ikigai-infotech-llp-saleshandy-ilt9kdxu",
  name: "Ikigai Infotech LLP (Saleshandy)",
  careersUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  tenantUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  apiMeta: null,
};

// Trimmed real markup from POST https://jobs.gohire.io/<tenant>/ (page 1 of 3, 25 total).
const LIST_PAGE_1 = `
<div class="jobs">
  <div class="job-container">
    <a class="gohire-job" href="https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">Senior Content Marketer</h3></div>
        <div class="career-location"><p class="careers-location">Ahmedabad, India</p></div>
      </div>
      <p class="date-posted">Posted 24 June, 2026</p>
    </a>
    <a class="gohire-job" href="https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/sdet-2-manual-automation-291946/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">SDET-2 (Manual + Automation)</h3></div>
        <div class="career-location"><p class="careers-location">Remote, India</p></div>
      </div>
      <p class="date-posted">Posted 16 June, 2026</p>
    </a>
  </div>
  <div class="jobs-pagination"><p class="gohire-job-pagination-results">Page <strong>1</strong> of <strong>3</strong>, Total <strong>25</strong> jobs</p></div>
</div>`;

const LIST_PAGE_EMPTY = `
<div class="jobs">
  <div class="job-container"></div>
  <div class="jobs-pagination"><p class="gohire-job-pagination-results">Page <strong>4</strong> of <strong>3</strong>, Total <strong>25</strong> jobs</p></div>
</div>`;

// Trimmed real JSON-LD island from a job detail page.
const DETAIL_PAGE = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{
  "@context": "http:\\/\\/schema.org\\/",
  "@type": "JobPosting",
  "title": "Senior Content Marketer",
  "datePosted": "2026-06-24",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "@type": "Organization", "name": "Ikigai Infotech LLP (Saleshandy)" },
  "jobLocation": {
    "@type": "Place",
    "address": { "@type": "PostalAddress", "addressLocality": "Ahmedabad", "addressRegion": "Gujarat", "addressCountry": "India" }
  },
  "description": "About the role<br>Saleshandy is a cold email platform. <b>What you'll do</b> build content.",
  "baseSalary": { "@type": "MonetaryAmount", "currency": "INR", "value": { "@type": "QuantitativeValue", "minValue": 600000, "maxValue": 1000000, "unitText": "YEAR" } }
}
</script>
</head><body></body></html>`;

const MALFORMED_LIST = `<div class="jobs"><p>Something went wrong.</p></div>`;
const MALFORMED_DETAIL = `<!DOCTYPE html><html><head><title>x</title></head><body>no ld+json here</body></html>`;

// A full 10-card page — matches the real page size, so the pagination loop's
// short-page check doesn't end it early; only the next (empty) page does.
function fullCard(n: number): string {
  return `<a class="gohire-job" href="https://jobs.gohire.io/${company.slug}/job-${n}-${1000 + n}/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">Job ${n}</h3></div>
        <div class="career-location"><p class="careers-location">Ahmedabad, India</p></div>
      </div>
      <p class="date-posted">Posted 24 June, 2026</p>
    </a>`;
}
const LIST_PAGE_FULL = `<div class="jobs"><div class="job-container">${Array.from({ length: 10 }, (_, i) => fullCard(i + 1)).join("")}</div></div>`;

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("gohireBoardUrl builds the POST target from the tenant slug", () => {
  assert.equal(
    gohireBoardUrl(company),
    "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  );
});

test("gohireExternalId extracts the trailing numeric id from a job-slug href", () => {
  assert.equal(
    gohireExternalId("https://jobs.gohire.io/tenant/senior-content-marketer-292750/"),
    "292750",
  );
  assert.equal(gohireExternalId("https://jobs.gohire.io/tenant/senior-content-marketer-292750"), "292750");
});

test("gohireExternalId returns null for a href with no trailing numeric id", () => {
  assert.equal(gohireExternalId("https://jobs.gohire.io/tenant/"), null);
});

test("parseGohireListPage extracts both cards: title, location, url, posted date", () => {
  const items = parseGohireListPage(LIST_PAGE_1, company);
  assert.equal(items.length, 2);

  const first = items[0];
  const second = items[1];
  assert.ok(first && second, "both cards parsed");
  assert.equal(first.provider, "gohire");
  assert.equal(first.externalId, "292750");
  assert.equal(first.jobTitle, "Senior Content Marketer");
  assert.equal(first.jobUrl, "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/");
  assert.equal(first.location, "Ahmedabad, India");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, "");
  assert.equal(first.postedAt, new Date("24 June, 2026").toISOString());

  assert.equal(second.externalId, "291946");
  assert.equal(second.location, "Remote, India");
  assert.equal(second.isRemote, true);
});

test("parseGohireListPage returns an empty array for a page with no job cards", () => {
  assert.deepEqual(parseGohireListPage(LIST_PAGE_EMPTY, company), []);
});

test("parseGohireListPage returns an empty array for malformed/unexpected markup", () => {
  assert.deepEqual(parseGohireListPage(MALFORMED_LIST, company), []);
});

const { fetchJd } = gohireAdapter;
assert(fetchJd);

test("gohireAdapter.fetchJd extracts the JSON-LD description and strips HTML", async () => {
  stubFetch(async () => new Response(DETAIL_PAGE, { status: 200 }));
  try {
    const posting: NormalizedPosting = {
      provider: "gohire",
      externalId: "292750",
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: "Senior Content Marketer",
      jobUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/",
      location: "Ahmedabad, India",
      isRemote: false,
      jdText: "",
      postedAt: null,
    };
    const jd = await fetchJd(company, posting);
    assert.match(jd, /Saleshandy is a cold email platform/);
    assert.match(jd, /What you'll do build content/);
    assert.doesNotMatch(jd, /<br>|<b>/);
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.fetchJd returns an empty string when the detail page has no JSON-LD island", async () => {
  stubFetch(async () => new Response(MALFORMED_DETAIL, { status: 200 }));
  try {
    const posting: NormalizedPosting = {
      provider: "gohire",
      externalId: "1",
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: "x",
      jobUrl: "https://jobs.gohire.io/tenant/x-1/",
      location: null,
      isRemote: false,
      jdText: "",
      postedAt: null,
    };
    const jd = await fetchJd(company, posting);
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings paginates via POST form body and stops on an empty page", async () => {
  const requests: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push(body);
    const page = new URLSearchParams(body).get("page");
    if (page === "1") return new Response(LIST_PAGE_FULL, { status: 200 });
    return new Response(LIST_PAGE_EMPTY, { status: 200 });
  });

  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 10, "page 1's 10 cards, page 2 empty");
    assert.equal(requests.length, 2, "stops after the first empty page");
    assert.match(requests[0] ?? "", /page=1/);
    assert.match(requests[0] ?? "", /remoteDdValue=all_Id/);
    assert.match(requests[0] ?? "", /typeDdValue=0/);
    assert.match(requests[1] ?? "", /page=2/);
  } finally {
    restoreFetch();
  }
});
