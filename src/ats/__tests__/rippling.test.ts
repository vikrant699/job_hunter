// src/ats/rippling.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ripplingListUrl, ripplingDetailUrl, normalizeRipplingJob, buildRipplingJd } from "../rippling.js";
import type { RipplingJob, RipplingDetail } from "../rippling.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "rippling",
  slug: "centricity-research",
  name: "Centricity Research",
  careersUrl: "https://ats.rippling.com/centricity-research/jobs",
  tenantUrl: null,
  apiMeta: null,
};

// --- URL builders ----------------------------------------------------------

test("ripplingListUrl builds the board list endpoint", () => {
  assert.equal(
    ripplingListUrl("centricity-research"),
    "https://api.rippling.com/platform/api/ats/v1/board/centricity-research/jobs",
  );
});

test("ripplingListUrl encodes the slug", () => {
  assert.equal(
    ripplingListUrl("a b"),
    "https://api.rippling.com/platform/api/ats/v1/board/a%20b/jobs",
  );
});

test("ripplingDetailUrl builds the job-detail endpoint", () => {
  assert.equal(
    ripplingDetailUrl("centricity-research", "9bfc0d02-c747-4294-b620-45512a302418"),
    "https://api.rippling.com/platform/api/ats/v1/board/centricity-research/jobs/9bfc0d02-c747-4294-b620-45512a302418",
  );
});

// --- normalizeRipplingJob: real-shaped list fixtures ------------------------

// Live-captured shape from GET api.rippling.com/platform/api/ats/v1/board/
// centricity-research/jobs — one entry per (job, location) pair, same uuid
// duplicated across locations.
const REAL_LIST_JOBS: RipplingJob[] = [
  {
    uuid: "9bfc0d02-c747-4294-b620-45512a302418",
    name: "Chief Financial Officer",
    department: { id: "Executive Leadership", label: "Executive Leadership" },
    url: "https://ats.rippling.com/centricity-research/jobs/9bfc0d02-c747-4294-b620-45512a302418",
    workLocation: { label: "Canada", id: "Canada" },
  },
  {
    uuid: "9bfc0d02-c747-4294-b620-45512a302418",
    name: "Chief Financial Officer",
    department: { id: "Executive Leadership", label: "Executive Leadership" },
    url: "https://ats.rippling.com/centricity-research/jobs/9bfc0d02-c747-4294-b620-45512a302418",
    workLocation: { label: "United States", id: "United States" },
  },
  {
    uuid: "6fe154be-5ed2-4770-abf9-f804bf24aa8e",
    name: "Research Assistant (Remote with travel)",
    department: { id: "Clinical Operations", label: "Clinical Operations" },
    url: "https://ats.rippling.com/centricity-research/jobs/6fe154be-5ed2-4770-abf9-f804bf24aa8e",
    workLocation: { label: "Remote (United States)", id: "Remote (United States)" },
  },
];

test("normalizeRipplingJob maps fields and dedups nothing (one row per location)", () => {
  const p = normalizeRipplingJob(company, at(REAL_LIST_JOBS, 0));
  assert.equal(p.provider, "rippling");
  assert.equal(p.externalId, "9bfc0d02-c747-4294-b620-45512a302418");
  assert.equal(p.companySlug, "centricity-research");
  assert.equal(p.companyName, "Centricity Research");
  assert.equal(p.jobTitle, "Chief Financial Officer");
  assert.equal(p.jobUrl, "https://ats.rippling.com/centricity-research/jobs/9bfc0d02-c747-4294-b620-45512a302418");
  assert.equal(p.location, "Canada");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeRipplingJob detects remote via REMOTE_RE on the location label", () => {
  const p = normalizeRipplingJob(company, at(REAL_LIST_JOBS, 2));
  assert.equal(p.location, "Remote (United States)");
  assert.equal(p.isRemote, true);
});

test("normalizeRipplingJob handles a null workLocation", () => {
  const job: RipplingJob = {
    uuid: "abc",
    name: "Some Role",
    department: null,
    url: "https://ats.rippling.com/centricity-research/jobs/abc",
    workLocation: null,
  };
  const p = normalizeRipplingJob(company, job);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

// --- buildRipplingJd: real-shaped detail fixture ----------------------------

// Trimmed live-captured shape from GET api.rippling.com/platform/api/ats/v1/
// board/centricity-research/jobs/9bfc0d02-c747-4294-b620-45512a302418 —
// description.company is the "why join us" blurb, description.role is the
// "about the role" body, both HTML.
const REAL_DETAIL: RipplingDetail = {
  uuid: "9bfc0d02-c747-4294-b620-45512a302418",
  description: {
    company:
      '<meta><p><b><strong>Join Us at Centricity Research!</strong></b></p><p><span>Centricity Research is one of North America’s fastest-growing clinical research networks.</span></p>',
    role:
      '<meta><p><b><strong>About the role</strong></b></p><p><span>As a key partner to the executive team, the CFO will ensure the right people, processes, and systems are in place.</span></p>',
  },
};

test("buildRipplingJd concatenates company then role and strips HTML", () => {
  const jd = buildRipplingJd(REAL_DETAIL);
  assert.match(jd, /Join Us at Centricity Research!/);
  assert.match(jd, /About the role/);
  assert.match(jd, /key partner to the executive team/);
  assert.ok(!jd.includes("<p>"), "HTML tags should be stripped");
  // company blurb precedes role body
  assert.ok(jd.indexOf("Join Us at Centricity Research") < jd.indexOf("About the role"));
});

test("buildRipplingJd falls back to whichever of company/role is present", () => {
  const jd = buildRipplingJd({ uuid: "x", description: { company: null, role: "<p>Only the role text.</p>" } });
  assert.match(jd, /Only the role text\./);
});

test("buildRipplingJd throws when description is missing entirely", () => {
  assert.throws(() => buildRipplingJd({ uuid: "x", description: null }), /no JD-bearing fields/);
});

test("buildRipplingJd throws when description fields are blank", () => {
  assert.throws(
    () => buildRipplingJd({ uuid: "x", description: { company: "", role: "   " } }),
    /no JD-bearing fields/,
  );
});
