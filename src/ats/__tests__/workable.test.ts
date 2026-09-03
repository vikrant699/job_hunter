import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkable } from "../workable.js";
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
