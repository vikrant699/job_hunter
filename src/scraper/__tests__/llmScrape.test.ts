import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmScrapeAdapter, dropCrossCompanyYcLinks } from "../llmScrape.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "../../ats/__tests__/testHelpers.js";

const company: AdapterCompany = {
  provider: "custom", slug: "acme", name: "Acme",
  careersUrl: "https://acme.example/careers", tenantUrl: null, apiMeta: null,
};

const LD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Senior Data Engineer",
  url: "https://acme.example/jobs/123",
  datePosted: "2026-06-01",
  description: "<p>Build pipelines and dashboards for analytics teams across the company, owning metrics end to end.</p>",
  jobLocation: { address: { addressLocality: "Bengaluru", addressRegion: "KA", addressCountry: "IN" } },
})}</script></head><body></body></html>`;

test("listPostings returns JSON-LD postings directly — location metadata, no LLM call", async () => {
  const adapter = createLlmScrapeAdapter({
    tag: "test-ld",
    fetcher: async (url) => ({ finalUrl: url, html: LD_PAGE }),
  });
  const out = await adapter.listPostings(company);
  assert.equal(out.length, 1);
  const out0 = at(out, 0);
  assert.equal(out0.jobTitle, "Senior Data Engineer");
  assert.equal(out0.location, "Bengaluru, KA, IN");
  assert.equal(out0.jobUrl, "https://acme.example/jobs/123");
  assert.equal(out0.postedAt, "2026-06-01");
  assert.match(out0.jdText, /Build pipelines/);
});

test("fetchJd prefers the JD page's JSON-LD description over stripped main text", async () => {
  const adapter = createLlmScrapeAdapter({
    tag: "test-ld",
    fetcher: async (url) => ({ finalUrl: url, html: LD_PAGE }),
  });
  assert.ok(adapter.fetchJd);
  const jd = await adapter.fetchJd(company, {
    provider: "custom", externalId: "x", companySlug: "acme", companyName: "Acme",
    jobTitle: "Senior Data Engineer", jobUrl: "https://acme.example/jobs/123",
    location: null, isRemote: false, jdText: "", postedAt: null,
  });
  assert.match(jd, /Build pipelines/);
  assert.doesNotMatch(jd, /<p>/); // html stripped
});

// YC company pages embed job links for OTHER YC companies ("similar jobs" rails) that must not be attributed to this company.
test("dropCrossCompanyYcLinks drops other YC companies' job links, keeps own + external", () => {
  const items = [
    { url: "https://www.ycombinator.com/companies/drdroid/jobs/abc-backend-engineer", text: "Backend Engineer" },
    { url: "https://www.ycombinator.com/companies/confido/jobs/yDpi777-senior-frontend-engineer", text: "Senior Frontend Engineer" },
    { url: "https://www.ycombinator.com/companies/boldvoice/jobs/BSms6T6-fullstack-engineer", text: "Fullstack Engineer" },
    { url: "https://drdroid.io/careers/sre", text: "SRE" },
  ];
  const kept = dropCrossCompanyYcLinks(items, "https://www.ycombinator.com/companies/drdroid/jobs");
  assert.deepEqual(kept.map((i) => i.text), ["Backend Engineer", "SRE"]);
});

test("dropCrossCompanyYcLinks matches YC hosts with and without www", () => {
  const items = [
    { url: "https://ycombinator.com/companies/other-co/jobs/x", text: "drop" },
    { url: "https://www.ycombinator.com/companies/kaagaz-scanner/jobs/y", text: "keep" },
  ];
  const kept = dropCrossCompanyYcLinks(items, "https://ycombinator.com/companies/kaagaz-scanner");
  assert.deepEqual(kept.map((i) => i.text), ["keep"]);
});

test("dropCrossCompanyYcLinks is a no-op for a non-YC careers page", () => {
  const items = [
    { url: "https://www.ycombinator.com/companies/someone/jobs/z", text: "yc link on own site" },
    { url: "https://acme.example/jobs/1", text: "own job" },
  ];
  const kept = dropCrossCompanyYcLinks(items, "https://acme.example/careers");
  assert.equal(kept.length, 2);
});

test("dropCrossCompanyYcLinks tolerates unparseable candidate URLs", () => {
  const items = [{ url: "not a url", text: "junk" }];
  const kept = dropCrossCompanyYcLinks(items, "https://www.ycombinator.com/companies/drdroid/jobs");
  assert.equal(kept.length, 1);
});
