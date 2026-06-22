import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGreythr, greythrBase, GreythrJobSchema, type GreythrJob } from "./greythr.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "greythr",
  slug: "firstclub",
  name: "FirstClub",
  careersUrl: "https://firstclub.greythr.com/hire/jobs/",
  tenantUrl: "https://firstclub.greythr.com",
  apiMeta: null,
};

// Trimmed real item from POST /hire/api/career/published_jobs/
const job: GreythrJob = {
  id: "ee737ce8-dec0-4ede-80fc-61ffee8d3a29",
  title: "CX Agent",
  slug: "cx-agent-679",
  req_id: "1131",
  description: "<p><strong>L1 Customer Support</strong></p><p>Support our customers.</p>",
  apply_url: "https://firstclub.greythr.com/hire/jobs/cx-agent-679",
  is_remote: false,
  created_at: "2026-06-06T13:49:24.033946Z",
};

test("greythrBase prefers tenant_url origin, falls back to slug subdomain", () => {
  assert.equal(greythrBase(company), "https://firstclub.greythr.com");
  assert.equal(
    greythrBase({ ...company, tenantUrl: null }),
    "https://firstclub.greythr.com",
  );
});

test("GreythrJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(GreythrJobSchema.safeParse(job).success);
  assert.ok(GreythrJobSchema.safeParse({ id: "x", title: "y" }).success);
  assert.equal(GreythrJobSchema.safeParse({ title: "no id" }).success, false);
});

test("normalizeGreythr maps fields, strips HTML JD, leaves location null", () => {
  const p = normalizeGreythr(company, job);
  assert.equal(p.provider, "greythr");
  assert.equal(p.externalId, "ee737ce8-dec0-4ede-80fc-61ffee8d3a29");
  assert.equal(p.jobTitle, "CX Agent");
  assert.equal(p.jobUrl, "https://firstclub.greythr.com/hire/jobs/cx-agent-679");
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, "2026-06-06T13:49:24.033946Z");
  assert.match(p.jdText, /L1 Customer Support/);
  assert.doesNotMatch(p.jdText, /<p>/);
});

test("normalizeGreythr synthesizes a job URL from slug when apply_url is absent", () => {
  const p = normalizeGreythr(company, { ...job, apply_url: null });
  assert.equal(p.jobUrl, "https://firstclub.greythr.com/hire/jobs/cx-agent-679");
});

test("normalizeGreythr honors is_remote", () => {
  assert.equal(normalizeGreythr(company, { ...job, is_remote: true }).isRemote, true);
});
