import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMetaJob, extractMetaJd, parsePostData, stripForLoopPrefix,
  indiaSearchVariables, LocationFilterResponseSchema, SearchResultsResponseSchema,
} from "../metacareers.js";
import type { MetaJob } from "../metacareers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "metacareers", slug: "meta", name: "Meta",
  careersUrl: "https://www.metacareers.com/jobs/", tenantUrl: null, apiMeta: null,
};

const job: MetaJob = {
  id: "1502620761640503",
  title: "ASIC Engineer, Design",
  locations: ["Bangalore, India"],
  teams: ["Infrastructure"],
  sub_teams: ["Hardware"],
};

test("normalizeMetaJob maps id/title/url and joins multi-location", () => {
  const p = normalizeMetaJob(company, { ...job, locations: ["Bangalore, India", "Gurgaon, India"] });
  assert.equal(p.provider, "metacareers");
  assert.equal(p.externalId, "1502620761640503");
  assert.equal(p.jobTitle, "ASIC Engineer, Design");
  assert.equal(p.jobUrl, "https://www.metacareers.com/jobs/1502620761640503/");
  assert.equal(p.location, "Bangalore, India; Gurgaon, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null); // search result carries no date — documented limitation
});

test("normalizeMetaJob maps a single location and remote text", () => {
  const p = normalizeMetaJob(company, { ...job, locations: ["Remote, India"] });
  assert.equal(p.location, "Remote, India");
  assert.equal(p.isRemote, true);
});

test("normalizeMetaJob handles a missing locations array", () => {
  const p = normalizeMetaJob(company, { ...job, locations: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

// Fixture: the live CareersJobSearchResultsV2DataQuery response shape, offices filtered to the discovered India office ids.
const SEARCH_RESULTS_FIXTURE = {
  data: {
    job_search_with_featured_jobs_v2: {
      all_jobs: [
        { id: "1502620761640503", title: "ASIC Engineer, Design", locations: ["Bangalore, India"], teams: ["Infrastructure"], sub_teams: ["Hardware"] },
        { id: "969723842791144", title: "Client Partner - eCommerce & Retail", locations: ["Bangalore, India"], teams: ["Sales & Marketing"], sub_teams: ["Client Solutions", "Sales"] },
        { id: "27662976979965092", title: "Technical Solutions Consultant, Meta Business Agent", locations: ["Gurgaon, India"], teams: ["Advertising Technology"], sub_teams: ["Client Solutions", "Solutions Engineering", "Technical Account Management"] },
      ],
      featured_jobs: [],
      featured_jobs_title: "Featured Jobs",
      all_jobs_title: "All Jobs",
    },
  },
  extensions: { server_metadata: { request_start_time_ms: 1, time_at_flush_ms: 2 }, is_final: true },
};

test("SearchResultsResponseSchema parses the live all_jobs response shape", () => {
  const parsed = SearchResultsResponseSchema.parse(SEARCH_RESULTS_FIXTURE);
  assert.equal(parsed.data.job_search_with_featured_jobs_v2.all_jobs.length, 3);
  assert.equal(parsed.data.job_search_with_featured_jobs_v2.all_jobs[0]?.title, "ASIC Engineer, Design");
});

// Fixture: the live CareersJobSearchLocationFilterV3Query response shape, trimmed to a few entries spanning multiple countries.
const LOCATION_FILTER_FIXTURE = {
  data: {
    job_search_filters: {
      locations: [
        { id: "austin", location_display_name: "Austin, TX", is_remote: false, state: "Texas", country: "United States" },
        { id: "bangalore", location_display_name: "Bangalore, India", is_remote: false, state: "Karnātaka", country: "India" },
        { id: "gurgaon", location_display_name: "Gurgaon, India", is_remote: false, state: "Haryāna", country: "India" },
        { id: "hyderabad", location_display_name: "Hyderabad, India", is_remote: false, state: "Telangāna", country: "India" },
        { id: "mumbai", location_display_name: "Mumbai, India", is_remote: false, state: "Mahārāshtra", country: "India" },
        { id: "newdelhi", location_display_name: "New Delhi, India", is_remote: true, state: "Delhi", country: "India" },
      ],
    },
  },
};

test("LocationFilterResponseSchema parses the live locations response and India entries filter cleanly", () => {
  const parsed = LocationFilterResponseSchema.parse(LOCATION_FILTER_FIXTURE);
  const india = parsed.data.job_search_filters.locations.filter((l) => l.country === "India").map((l) => l.id);
  assert.deepEqual(india, ["bangalore", "gurgaon", "hyderabad", "mumbai", "newdelhi"]);
});

test("parsePostData extracts friendly name, doc_id, and lsd from a live-shaped POST body", () => {
  const postData =
    "av=0&__user=0&__a=1&lsd=AdRh8cIXpWSRXRlJaYqU1lRIzg0&jazoest=22352" +
    "&fb_api_caller_class=RelayModern&fb_api_req_friendly_name=CareersJobSearchResultsV2DataQuery" +
    "&server_timestamps=true&variables=%7B%7D&doc_id=27129360303422352";
  const parsed = parsePostData(postData);
  assert.equal(parsed.friendlyName, "CareersJobSearchResultsV2DataQuery");
  assert.equal(parsed.docId, "27129360303422352");
  assert.equal(parsed.lsd, "AdRh8cIXpWSRXRlJaYqU1lRIzg0");
});

test("parsePostData tolerates a missing/null body (no graphql request matched yet)", () => {
  assert.deepEqual(parsePostData(null), { friendlyName: null, docId: null, lsd: null });
});

test("stripForLoopPrefix removes the FB anti-JSON-hijacking prefix when present", () => {
  assert.equal(stripForLoopPrefix('for (;;);{"data":1}'), '{"data":1}');
});

test("stripForLoopPrefix is a no-op on a plain JSON body (the observed live shape)", () => {
  assert.equal(stripForLoopPrefix('{"data":1}'), '{"data":1}');
});

test("indiaSearchVariables builds the search_input shape with offices filled and everything else empty/false", () => {
  const v = indiaSearchVariables(["bangalore", "gurgaon"]);
  assert.deepEqual(v.search_input.offices, ["bangalore", "gurgaon"]);
  assert.equal(v.search_input.q, null);
  assert.equal(v.search_input.is_remote_only, false);
  assert.equal(v.isLoggedIn, false);
});

// Fixture: the live job-detail page's schema.org JobPosting JSON-LD block, server-rendered inside the "for (;;);"-free HTML at domcontentloaded.
const JOB_DETAIL_HTML = `<!doctype html><html><head>
<script type="application/ld+json" nonce="abc123">{"@context":"http://schema.org/","@type":"JobPosting","title":"ASIC Engineer, Design","description":"The Infra-Silicon team at Meta designs ASICs.\\n","responsibilities":"Develop RTL designs&nbsp;Collaborate with verification engineers","hiringOrganization":{"@type":"Organization","name":"Meta"},"datePosted":"2026-07-07T22:04:31-07:00","jobLocation":[{"@type":"Place","name":"Bangalore, India"}],"qualifications":"Bachelor's degree&nbsp;2+ years of experience","employmentType":"FULL_TIME"}</script>
</head><body>other page chrome</body></html>`;

test("extractMetaJd flattens description + responsibilities + qualifications and decodes entities", () => {
  const jd = extractMetaJd(JOB_DETAIL_HTML);
  assert.match(jd, /Infra-Silicon team at Meta designs ASICs/);
  assert.match(jd, /Responsibilities/);
  assert.match(jd, /Develop RTL designs Collaborate with verification engineers/); // &nbsp; decoded to space
  assert.match(jd, /Minimum Qualifications/);
  assert.match(jd, /Bachelor's degree 2\+ years of experience/);
});

test("extractMetaJd returns empty string when no JobPosting ld+json block is present", () => {
  assert.equal(extractMetaJd("<html><body>no jobs here</body></html>"), "");
});

test("extractMetaJd returns empty string on malformed JSON inside the script tag", () => {
  const html = '<script type="application/ld+json">{not valid json</script>';
  assert.equal(extractMetaJd(html), "");
});

test("extractMetaJd skips a non-JobPosting ld+json block (e.g. an Organization/breadcrumb schema)", () => {
  const html = '<script type="application/ld+json">{"@type":"Organization","name":"Meta"}</script>';
  assert.equal(extractMetaJd(html), "");
});
