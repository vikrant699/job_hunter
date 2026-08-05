// src/ats/ubs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ubsField, parseUbsMatchedJobs, ubsReportedJobsCount, ubsTruncationWarning } from "../ubs.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "ubs",
  slug: "ubs-pw",
  name: "UBS India",
  careersUrl: "https://jobs.ubs.com/TGnewUI/Search/home/Home?partnerid=25008&siteid=5012",
  tenantUrl: null,
  apiMeta: null,
};

const PAYLOAD = {
  Jobs: {
    Job: [
      {
        Questions: [
          { QuestionName: "reqid", Value: "330284" },
          { QuestionName: "jobtitle", Value: "Test Automation Engineer - Python" },
          { QuestionName: "formtext23", Value: "India" },
          { QuestionName: "department", Value: "Group Functions" },
          { QuestionName: "lastupdated", Value: "17-Jul-2026" },
          { QuestionName: "jobdescription", Value: "<p>Build test automation.</p>" },
        ],
      },
      // Duplicate reqid — must dedup.
      { Questions: [{ QuestionName: "reqid", Value: "330284" }, { QuestionName: "jobtitle", Value: "dup" }] },
      // Missing title — skipped.
      { Questions: [{ QuestionName: "reqid", Value: "999" }] },
    ],
  },
};

test("ubsField reads a Questions value as a trimmed string", () => {
  assert.equal(ubsField(at(PAYLOAD.Jobs.Job, 0), "jobtitle"), "Test Automation Engineer - Python");
  assert.equal(ubsField(at(PAYLOAD.Jobs.Job, 0), "nope"), null);
});

test("parseUbsMatchedJobs maps fields, strips JD HTML, dedups, builds deep link", () => {
  const p = parseUbsMatchedJobs(PAYLOAD, company, company.careersUrl, "5012");
  assert.equal(p.length, 1);
  const j = at(p, 0);
  assert.equal(j.externalId, "330284");
  assert.equal(j.jobTitle, "Test Automation Engineer - Python");
  assert.equal(j.location, "India");
  assert.equal(j.jdText, "Build test automation.");
  assert.equal(j.postedAt, "17-Jul-2026");
  assert.match(j.jobUrl, /#jobDetails=330284_5012$/);
});

test("parseUbsMatchedJobs returns [] on an empty/absent Jobs array", () => {
  assert.deepEqual(parseUbsMatchedJobs({}, company, company.careersUrl, "5012"), []);
  assert.deepEqual(parseUbsMatchedJobs({ Jobs: { Job: [] } }, company, company.careersUrl, "5012"), []);
});

// The MatchedJobs response caps at 50 jobs (verified live: an unfiltered search
// reports JobsCount=577 and returns 50), and this adapter has no pagination.
// `JobsCount` is the server's own count for the search, so a shortfall against
// it is the ONLY signal that the India set has outgrown one response.
test("ubsReportedJobsCount reads the server's own count for the search", () => {
  assert.equal(ubsReportedJobsCount({ ...PAYLOAD, JobsCount: 20 }), 20);
  assert.equal(ubsReportedJobsCount(PAYLOAD), null);
  assert.equal(ubsReportedJobsCount({ JobsCount: "not-a-number" }), null);
});

test("ubsTruncationWarning fires when fewer jobs came back than the server reported", () => {
  assert.equal(ubsTruncationWarning(50, 577), "ubs: returned 50 of 577 reported jobs — response is truncated");
});

test("ubsTruncationWarning stays silent on a complete response", () => {
  assert.equal(ubsTruncationWarning(20, 20), null);
  // Dedup/skipped rows legitimately shrink the parsed count below the raw one;
  // only a shortfall against the SERVER's count means jobs were never sent.
  assert.equal(ubsTruncationWarning(20, null), null);
  assert.equal(ubsTruncationWarning(21, 20), null);
});
