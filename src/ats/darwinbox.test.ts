// src/ats/darwinbox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDarwinbox, darwinboxTenantBase } from "./darwinbox.js";
import type { DarwinboxJob } from "./darwinbox.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "darwinbox", slug: "emeritus", name: "Emeritus",
  careersUrl: "https://emeritus.darwinbox.in/ms/candidate/careers",
  tenantUrl: "https://emeritus.darwinbox.in/ms/candidate/careers", apiMeta: null,
};

const job: DarwinboxJob = {
  id: "a66faa21bc4531", title: "Team Leader - Sales", designation_display_name: "Team Leader",
  officelocation_show_arr: "Mumbai, Maharashtra, India", job_posting_on: 1780511400,
  created_on: "2024-09-30T13:05:31.000Z",
};

test("darwinboxTenantBase derives the origin", () => {
  assert.equal(darwinboxTenantBase(company), "https://emeritus.darwinbox.in");
});

test("normalizeDarwinbox maps fields, prefers title, converts epoch", () => {
  const p = normalizeDarwinbox(company, job);
  assert.equal(p.provider, "darwinbox");
  assert.equal(p.externalId, "a66faa21bc4531");
  assert.equal(p.jobTitle, "Team Leader - Sales");
  assert.equal(p.location, "Mumbai, Maharashtra, India");
  assert.equal(p.postedAt, new Date(1780511400 * 1000).toISOString());
});

test("normalizeDarwinbox falls back to designation when title empty", () => {
  const p = normalizeDarwinbox(company, { ...job, title: "" });
  assert.equal(p.jobTitle, "Team Leader");
});
