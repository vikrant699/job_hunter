import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmScrapeAdapter } from "./llm-scrape.js";
import type { AdapterCompany } from "../types.js";

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
  assert.equal(out[0]!.jobTitle, "Senior Data Engineer");
  assert.equal(out[0]!.location, "Bengaluru, KA, IN");
  assert.equal(out[0]!.jobUrl, "https://acme.example/jobs/123");
  assert.equal(out[0]!.postedAt, "2026-06-01");
  assert.match(out[0]!.jdText, /Build pipelines/);
});

test("fetchJd prefers the JD page's JSON-LD description over stripped main text", async () => {
  const adapter = createLlmScrapeAdapter({
    tag: "test-ld",
    fetcher: async (url) => ({ finalUrl: url, html: LD_PAGE }),
  });
  const jd = await adapter.fetchJd!(company, {
    provider: "custom", externalId: "x", companySlug: "acme", companyName: "Acme",
    jobTitle: "Senior Data Engineer", jobUrl: "https://acme.example/jobs/123",
    location: null, isRemote: false, jdText: "", postedAt: null,
  });
  assert.match(jd, /Build pipelines/);
  assert.doesNotMatch(jd, /<p>/); // html stripped
});
