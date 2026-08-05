// src/ats/squareyards.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SquareYardsJobSchema,
  squareyardsJobsFrom,
  squareyardsDeptUrl,
  normalizeSquareYards,
  SQUAREYARDS_DEPARTMENTS,
} from "../squareyards.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "squareyards", slug: "square-yards", name: "Square Yards",
  careersUrl: "https://www.squareyards.com/career",
  tenantUrl: null, apiMeta: null,
};

// Trimmed from the real https://www.squareyards.com/career/Technology
// response (verified live 2026-08-01).
const RESPONSE = {
  status: 1,
  message: "Successfully",
  data: [
    {
      id: 11375, jobId: "JD8729",
      positionName: "Business Development Manager (Data Intelligence) ",
      openPosition: 1, total: 1, noOfClosePosition: 0, remarks: "",
      status: "Open", verticalName: "Services", department: "Technology",
      location: "Mumbai",
      description: "<p><strong>Business Development Manager</strong> role.</p>",
      recuiterId: "100787", employeeName: "Antara Das", isPublish: 1, postedOn: "",
    },
    {
      id: 6512, jobId: "JD3866", positionName: "Data Analyst",
      openPosition: 99, total: 100, noOfClosePosition: 1,
      status: "Open", verticalName: "Support", department: "Technology",
      location: "Gurgaon", description: "<p>Analyze data.</p>",
      postedOn: "",
    },
  ],
};

test("SQUAREYARDS_DEPARTMENTS lists the enumerated nav departments", () => {
  assert.deepEqual(SQUAREYARDS_DEPARTMENTS, ["Sales", "Technology", "Marketing", "HR", "Finance", "Operations"]);
});

test("squareyardsDeptUrl builds the department-scoped career URL", () => {
  assert.equal(squareyardsDeptUrl("https://www.squareyards.com", "Technology"), "https://www.squareyards.com/career/Technology");
});

test("squareyardsJobsFrom reads the data array from a live-shaped response", () => {
  const jobs = squareyardsJobsFrom(RESPONSE);
  assert.equal(jobs.length, 2);
});

test("squareyardsJobsFrom tolerates a malformed/non-JSON-shaped response by returning []", () => {
  assert.deepEqual(squareyardsJobsFrom("<!doctype html><html>...</html>"), []);
  assert.deepEqual(squareyardsJobsFrom(null), []);
  assert.deepEqual(squareyardsJobsFrom({ status: 0 }), []);
});

test("SquareYardsJobSchema rejects a record with no id", () => {
  assert.equal(SquareYardsJobSchema.safeParse({ positionName: "No id" }).success, false);
});

test("normalizeSquareYards maps positionName/location/HTML-stripped JD, externalId prefers jobId", () => {
  const jobs = squareyardsJobsFrom(RESPONSE);
  const p = normalizeSquareYards(company, "Technology", "https://www.squareyards.com", SquareYardsJobSchema.parse(jobs[0]));
  assert.equal(p.provider, "squareyards");
  assert.equal(p.externalId, "JD8729");
  assert.equal(p.jobTitle, "Business Development Manager (Data Intelligence) ");
  assert.equal(p.location, "Mumbai");
  assert.equal(p.jobUrl, "https://www.squareyards.com/career/Technology");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Business Development Manager role\./);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
});

test("normalizeSquareYards falls back to String(id) when jobId is absent", () => {
  const noJobId = SquareYardsJobSchema.parse({ id: 42, positionName: "No JobId Role", location: "Pune" });
  const p = normalizeSquareYards(company, "Sales", "https://www.squareyards.com", noJobId);
  assert.equal(p.externalId, "42");
});

test("normalizeSquareYards detects a remote location and treats a blank location as null", () => {
  const remote = SquareYardsJobSchema.parse({ id: 1, jobId: "JD1", positionName: "Remote Role", location: "Remote" });
  assert.equal(normalizeSquareYards(company, "Sales", "https://www.squareyards.com", remote).isRemote, true);

  const blank = SquareYardsJobSchema.parse({ id: 2, jobId: "JD2", positionName: "Blank Loc Role", location: "" });
  const p = normalizeSquareYards(company, "Sales", "https://www.squareyards.com", blank);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});
