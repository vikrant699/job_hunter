// src/ats/oracle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOracle } from "./oracle.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "oracle", slug: "onsemi", name: "ON Semiconductor",
  careersUrl: "https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1",
  tenantUrl: "https://hctz.fa.us2.oraclecloud.com", apiMeta: { siteNumber: "CX_1" },
};

const req = {
  Id: "300001234567890", Title: "Senior Data Analyst",
  PostedDate: "2026-06-02", PrimaryLocation: "Bengaluru, KA, India", secondaryLocations: [],
};

test("normalizeOracle maps list metadata and builds the CE job URL", () => {
  const p = normalizeOracle(company, req);
  assert.equal(p.externalId, "300001234567890");
  assert.equal(p.jobTitle, "Senior Data Analyst");
  assert.equal(p.location, "Bengaluru, KA, India");
  assert.equal(p.jobUrl, "https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/300001234567890");
  assert.equal(p.jdText, ""); // two-phase
  assert.equal(p.postedAt, "2026-06-02");
});
