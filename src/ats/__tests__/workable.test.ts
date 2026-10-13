import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkable, workableAdapter } from "../workable.js";
import { fetchSequence, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "workable", slug: "tiger-analytics", name: "Tiger Analytics",
  careersUrl: "https://apply.workable.com/tiger-analytics/", tenantUrl: null, apiMeta: null,
};

const job = {
  title: "Business Analyst", shortcode: "ABC123",
  url: "https://apply.workable.com/j/ABC123", telecommuting: false,
  published_on: "2026-05-01", country: "India", city: "Bengaluru", state: "KA",
  locations: [{ country: "India", countryCode: "IN", city: "Bengaluru", region: "KA" }],
  description: "<p>Analyze data with <strong>SQL</strong> and build dashboards.</p>",
};

test("normalizeWorkable maps fields and flattens location", () => {
  const p = normalizeWorkable(company, job);
  assert.equal(p.provider, "workable");
  assert.equal(p.externalId, "ABC123");
  assert.equal(p.jobTitle, "Business Analyst");
  assert.equal(p.location, "Bengaluru, KA, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jobUrl, "https://apply.workable.com/j/ABC123");
  assert.match(p.jdText, /Analyze data with SQL/);
});

test("normalizeWorkable joins ALL locations so an India-second posting is not geo-rejected", () => {
  const p = normalizeWorkable(company, {
    title: "Staff Engineer",
    shortcode: "ABC123",
    locations: [
      { city: "Boston", region: "MA", country: "United States" },
      { city: "Bengaluru", region: "Karnataka", country: "India" },
    ],
  });
  assert.equal(p.location, "Boston, MA, United States; Bengaluru, Karnataka, India");
});

test("listPostings collapses the widget's one-row-per-location repeats into one posting per shortcode", async (t) => {
  const row = (city: string, country: string) => ({
    title: "Backend Engineer", shortcode: "5BC5EFE64F", url: "https://apply.workable.com/j/5BC5EFE64F",
    city, country, locations: [{ city, country }], description: "<p>Build APIs.</p>",
  });
  stubFetch(t, fetchSequence(() => jsonResponse({
    name: "CoverGo",
    jobs: [row("", "Philippines"), row("Bengaluru", "India"), row("Pune", "India"), { ...row("Lisbon", "Portugal"), shortcode: "OTHER1" }],
  })));
  const postings = await workableAdapter.listPostings(company);
  assert.deepEqual(postings.map((p) => [p.externalId, p.location]), [
    ["5BC5EFE64F", "Philippines; Bengaluru, India; Pune, India"],
    ["OTHER1", "Lisbon, Portugal"],
  ]);
});

test("listPostings reads the account from tenantUrl when apiMeta names none", async (t) => {
  const urls: string[] = [];
  stubFetch(t, (input) => {
    urls.push(String(input));
    return Promise.resolve(jsonResponse({ name: "SaveIN", jobs: [] }));
  });
  await workableAdapter.listPostings(mkAdapterCompany(
    { provider: "workable", slug: "savein", name: "SaveIN", careersUrl: "https://savein.money/career" },
    { tenantUrl: "https://apply.workable.com/api/v1/widget/accounts/savein-fintech-private-limited" },
  ));
  await workableAdapter.listPostings(mkAdapterCompany(
    { provider: "workable", slug: "oyo-rooms", name: "OYO", careersUrl: "https://www.oyorooms.com/careers/" },
    { tenantUrl: "https://apply.workable.com/oyorooms/" },
  ));
  assert.deepEqual(urls, [
    "https://apply.workable.com/api/v1/widget/accounts/savein-fintech-private-limited?details=true",
    "https://apply.workable.com/api/v1/widget/accounts/oyorooms?details=true",
  ]);
});
