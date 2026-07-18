// src/ats/ubs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ubsField, parseUbsMatchedJobs } from "./ubs.js";
import type { AdapterCompany } from "../types.js";

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
  assert.equal(ubsField(PAYLOAD.Jobs.Job[0]!, "jobtitle"), "Test Automation Engineer - Python");
  assert.equal(ubsField(PAYLOAD.Jobs.Job[0]!, "nope"), null);
});

test("parseUbsMatchedJobs maps fields, strips JD HTML, dedups, builds deep link", () => {
  const p = parseUbsMatchedJobs(PAYLOAD, company, company.careersUrl, "5012");
  assert.equal(p.length, 1);
  const j = p[0]!;
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
