// src/ats/peoplestrong.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  peoplestrongListUrl,
  peoplestrongJdUrl,
  peoplestrongJobUrl,
  normalizePeoplestrong,
  parsePeoplestrongJd,
  PeoplestrongListSchema,
  type PeoplestrongJob,
} from "./peoplestrong.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "peoplestrong",
  slug: "rblcareers",
  name: "RBL Bank",
  careersUrl: "https://rblcareers.peoplestrong.com/",
  tenantUrl: null,
  apiMeta: null,
};

// Job with a null jobDetailUrl (RBL shape) — URL must be constructed.
const JOB_NO_URL: PeoplestrongJob = {
  jobCode: "RBL/RM-SB/1477632",
  jobTitle: "Relationship Manager – Signature Banking",
  locationHierarchy: "Bangalore",
  locationHierarchyComplete: "India>South>Karnataka>Bangalore",
  jobDetailUrl: null,
  jobPostedDate: "2025-09-11",
};

// Job with a populated jobDetailUrl (ABFRL shape) and a remote location.
const JOB_WITH_URL: PeoplestrongJob = {
  jobCode: "BFL/D-VA/1794956",
  jobTitle: "Remote Frontend Engineer",
  locationHierarchy: "Remote - India",
  jobDetailUrl: "https://abfrlcareers.peoplestrong.com/job/detail/BFL_D-VA_1794956",
  jobPostedDate: "2026-07-08",
};

test("peoplestrongListUrl builds the paged POST list endpoint", () => {
  assert.equal(
    peoplestrongListUrl("https://rblcareers.peoplestrong.com", 0),
    "https://rblcareers.peoplestrong.com/api/cp/rest/altone/cp/jobs/v1?offset=0&limit=45",
  );
  assert.equal(
    peoplestrongListUrl("https://rblcareers.peoplestrong.com", 90),
    "https://rblcareers.peoplestrong.com/api/cp/rest/altone/cp/jobs/v1?offset=90&limit=45",
  );
});

test("peoplestrongJdUrl replaces / with _ in the jobCode and keeps the vendor spelling", () => {
  const url = peoplestrongJdUrl("https://rblcareers.peoplestrong.com", "RBL/RM-SB/1477632");
  assert.match(url, /\/cp\/job\/RBL_RM-SB_1477632\/v2\?/);
  assert.match(url, /descriprion/); // vendor misspelling is intentional
  assert.match(url, /isReqId=false$/);
});

test("peoplestrongJobUrl prefers jobDetailUrl, else constructs /job/detail/<_-code>", () => {
  assert.equal(
    peoplestrongJobUrl("https://rblcareers.peoplestrong.com", JOB_NO_URL),
    "https://rblcareers.peoplestrong.com/job/detail/RBL_RM-SB_1477632",
  );
  assert.equal(
    peoplestrongJobUrl("https://abfrlcareers.peoplestrong.com", JOB_WITH_URL),
    "https://abfrlcareers.peoplestrong.com/job/detail/BFL_D-VA_1794956",
  );
  // No code and no url -> portal root.
  assert.equal(peoplestrongJobUrl("https://x.peoplestrong.com", { jobCode: null }), "https://x.peoplestrong.com");
});

test("normalizePeoplestrong maps fields; constructs URL when jobDetailUrl is null", () => {
  const p = normalizePeoplestrong(company, JOB_NO_URL)!;
  assert.equal(p.provider, "peoplestrong");
  assert.equal(p.externalId, "RBL/RM-SB/1477632");
  assert.equal(p.companySlug, "rblcareers");
  assert.equal(p.companyName, "RBL Bank");
  assert.equal(p.jobTitle, "Relationship Manager – Signature Banking");
  assert.equal(p.jobUrl, "https://rblcareers.peoplestrong.com/job/detail/RBL_RM-SB_1477632");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, ""); // JD populated by fetchJd
  assert.equal(p.postedAt, new Date("2025-09-11").toISOString());
});

test("normalizePeoplestrong honors jobDetailUrl and detects remote locations", () => {
  const p = normalizePeoplestrong(company, JOB_WITH_URL)!;
  assert.equal(p.externalId, "BFL/D-VA/1794956");
  assert.equal(p.jobUrl, "https://abfrlcareers.peoplestrong.com/job/detail/BFL_D-VA_1794956");
  assert.equal(p.location, "Remote - India");
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, new Date("2026-07-08").toISOString());
});

test("normalizePeoplestrong returns null when the job has no jobCode", () => {
  assert.equal(normalizePeoplestrong(company, { jobTitle: "No Code", jobCode: null }), null);
  assert.equal(normalizePeoplestrong(company, { jobTitle: "No Code" }), null);
});

test("normalizePeoplestrong falls back to locationHierarchyComplete then null", () => {
  const complete = normalizePeoplestrong(company, {
    jobCode: "A/1",
    locationHierarchy: null,
    locationHierarchyComplete: "India>West>Maharashtra>Pune",
  })!;
  assert.equal(complete.location, "India>West>Maharashtra>Pune");
  const none = normalizePeoplestrong(company, { jobCode: "A/2" })!;
  assert.equal(none.location, null);
  assert.equal(none.isRemote, false);
});

test("PeoplestrongListSchema parses the wrapper and totalRecords pagination math", () => {
  const raw = {
    totalRecords: 57,
    response: [JOB_NO_URL, JOB_WITH_URL],
    messageCode: { code: 200, messages: "success" },
  };
  const parsed = PeoplestrongListSchema.safeParse(raw);
  assert.ok(parsed.success);
  assert.equal(parsed.data.totalRecords, 57);
  assert.equal(parsed.data.response.length, 2);
  // 57 records at page size 45 -> 2 pages.
  assert.equal(Math.ceil(parsed.data.totalRecords! / 45), 2);
});

test("empty board: response array present but empty", () => {
  const parsed = PeoplestrongListSchema.safeParse({ totalRecords: 0, response: [] });
  assert.ok(parsed.success);
  assert.equal(parsed.data.response.length, 0);
  assert.deepEqual(
    parsed.data.response.map((j) => normalizePeoplestrong(company, j)),
    [],
  );
});

test("malformed response: missing response array fails the schema", () => {
  assert.equal(PeoplestrongListSchema.safeParse({ totalRecords: 5 }).success, false);
  assert.equal(PeoplestrongListSchema.safeParse({ response: "nope" }).success, false);
  assert.equal(PeoplestrongListSchema.safeParse("garbage").success, false);
});

test("parsePeoplestrongJd extracts response.jobDescription and strips HTML", () => {
  const raw = {
    response: {
      jobTitle: "RM",
      jobDescription: "<p><strong>Purpose</strong></p><ul><li>Own the book</li><li>Cross-sell</li></ul>",
    },
  };
  const jd = parsePeoplestrongJd(raw);
  assert.match(jd, /Purpose/);
  assert.match(jd, /Own the book/);
  assert.match(jd, /Cross-sell/);
  assert.doesNotMatch(jd, /<p>|<li>|<strong>/i);
});

test("parsePeoplestrongJd returns empty string when the description is absent or malformed", () => {
  assert.equal(parsePeoplestrongJd({ response: {} }), "");
  assert.equal(parsePeoplestrongJd({ response: null }), "");
  assert.equal(parsePeoplestrongJd({}), "");
  assert.equal(parsePeoplestrongJd("garbage"), "");
});
