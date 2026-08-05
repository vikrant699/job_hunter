import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonLdJobs } from "../json-ld.js";
import { at } from "../../ats/__tests__/test-helpers.js";

function page(...scripts: string[]): string {
  const blocks = scripts
    .map((s) => `<script type="application/ld+json">${s}</script>`)
    .join("\n");
  return `<html><head>${blocks}</head><body><p>hello</p></body></html>`;
}

const FULL_POSTING = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Senior Data Engineer",
  url: "https://acme.example/jobs/123",
  datePosted: "2026-06-01",
  description: "<p>Build <b>pipelines</b></p>",
  jobLocation: {
    "@type": "Place",
    address: { addressLocality: "Bengaluru", addressRegion: "KA", addressCountry: "IN" },
  },
});

test("extracts a single JobPosting with flattened location", () => {
  const jobs = extractJsonLdJobs(page(FULL_POSTING));
  assert.equal(jobs.length, 1);
  const job0 = at(jobs, 0);
  assert.equal(job0.title, "Senior Data Engineer");
  assert.equal(job0.url, "https://acme.example/jobs/123");
  assert.equal(job0.location, "Bengaluru, KA, IN");
  assert.equal(job0.datePosted, "2026-06-01");
  assert.match(job0.description ?? "", /pipelines/);
});

test("finds JobPostings nested in @graph and in arrays", () => {
  const graph = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Acme" },
      { "@type": "JobPosting", title: "Backend Engineer", url: "https://acme.example/jobs/1" },
      { "@type": "JobPosting", title: "Frontend Engineer", url: "https://acme.example/jobs/2" },
    ],
  });
  const jobs = extractJsonLdJobs(page(graph));
  assert.deepEqual(jobs.map((j) => j.title), ["Backend Engineer", "Frontend Engineer"]);
});

test("finds JobPostings inside an ItemList's itemListElement/item", () => {
  const list = JSON.stringify({
    "@type": "ItemList",
    itemListElement: [
      { "@type": "ListItem", item: { "@type": "JobPosting", title: "Data Analyst" } },
    ],
  });
  assert.equal(at(extractJsonLdJobs(page(list)), 0).title, "Data Analyst");
});

test("multiple jobLocations join with semicolons; TELECOMMUTE adds Remote", () => {
  const multi = JSON.stringify({
    "@type": "JobPosting",
    title: "Platform Engineer",
    jobLocationType: "TELECOMMUTE",
    jobLocation: [
      { address: { addressLocality: "Mumbai", addressCountry: { "@type": "Country", name: "India" } } },
      { address: { addressLocality: "Pune" } },
    ],
  });
  const jobs = extractJsonLdJobs(page(multi));
  assert.equal(at(jobs, 0).location, "Mumbai, India; Pune; Remote");
});

test("skips malformed JSON blocks, postings without titles, and dedups repeats", () => {
  const jobs = extractJsonLdJobs(
    page("{not json", JSON.stringify({ "@type": "JobPosting", url: "https://x/no-title" }), FULL_POSTING, FULL_POSTING),
  );
  assert.equal(jobs.length, 1);
  assert.equal(at(jobs, 0).title, "Senior Data Engineer");
});

test("returns [] for pages with no JSON-LD at all", () => {
  assert.deepEqual(extractJsonLdJobs("<html><body>plain page</body></html>"), []);
});
