// src/ats/eightfold.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEightfold } from "./eightfold.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "eightfold", slug: "astrazeneca", name: "AstraZeneca",
  careersUrl: "https://astrazeneca.eightfold.ai/careers",
  tenantUrl: "https://astrazeneca.eightfold.ai", apiMeta: { domain: "astrazeneca.com" },
};

const position = {
  id: 563877690542312, name: "Analytics Manager - Mumbai",
  location: "Mumbai, , India", locations: ["Mumbai, , India"],
  t_create: 1780531200,
  canonicalPositionUrl: "https://astrazeneca.eightfold.ai/careers/job/563877690542312",
  job_description: "",
};

test("normalizeEightfold maps list metadata (JD fetched separately)", () => {
  const p = normalizeEightfold(company, position);
  assert.equal(p.externalId, "563877690542312");
  assert.equal(p.jobTitle, "Analytics Manager - Mumbai");
  assert.equal(p.location, "Mumbai, , India");
  assert.equal(p.jobUrl, "https://astrazeneca.eightfold.ai/careers/job/563877690542312");
  assert.equal(p.jdText, ""); // empty in list; populated by fetchJd
  assert.equal(p.postedAt, new Date(1780531200 * 1000).toISOString());
});
