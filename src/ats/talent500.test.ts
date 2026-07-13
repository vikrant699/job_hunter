// src/ats/talent500.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  talent500ListUrl,
  talent500DetailUrl,
  talent500JobUrl,
  talent500ShouldKeep,
  normalizeTalent500Job,
  talent500SlugFromUrl,
  buildTalent500Jd,
  type Talent500Job,
  type Talent500Detail,
} from "./talent500.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "talent500",
  slug: "best-buy-india",
  name: "Best Buy India",
  careersUrl: "https://talent500.com/jobs?company=best-buy-india",
  tenantUrl: null,
  apiMeta: null,
};

// --- URL builders -----------------------------------------------------------

test("talent500ListUrl builds a company_slug-filtered, offset/size-paged URL", () => {
  assert.equal(
    talent500ListUrl("best-buy-india", 0, 50),
    "https://prod-warmachine.talent500.co/api/v3/jobs/search/?company_slug=best-buy-india&offset=0&size=50",
  );
  assert.equal(
    talent500ListUrl("best-buy-india", 50),
    "https://prod-warmachine.talent500.co/api/v3/jobs/search/?company_slug=best-buy-india&offset=50&size=50",
  );
});

test("talent500DetailUrl builds the job-slug detail endpoint", () => {
  assert.equal(
    talent500DetailUrl("software-engineer-i-qa-bengaluru-T500-26950"),
    "https://prod-warmachine.talent500.co/api/jobs/software-engineer-i-qa-bengaluru-T500-26950/",
  );
});

test("talent500JobUrl builds the public job page URL", () => {
  assert.equal(
    talent500JobUrl("software-engineer-i-qa-bengaluru-T500-26950"),
    "https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950",
  );
});

// --- talent500ShouldKeep -----------------------------------------------------

const baseJob: Talent500Job = {
  id: "a1b2c3d4-0000-0000-0000-000000000001",
  title_alias_1: "Software Engineer I - QA",
  title: "SDE1",
  slug: "software-engineer-i-qa-bengaluru-T500-26950",
  location: "Bengaluru",
  country: { name: "India", country_code: "IN" },
  is_remote: false,
  created_at: "2026-06-24T14:51:54.811468+05:30",
  status: "open",
  is_active: true,
  is_job_displayable: true,
};

test("talent500ShouldKeep keeps a displayable, active, open job", () => {
  assert.equal(talent500ShouldKeep(baseJob), true);
});

test("talent500ShouldKeep drops a closed job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, status: "closed" }), false);
});

test("talent500ShouldKeep drops an undisplayable job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, is_job_displayable: false }), false);
});

test("talent500ShouldKeep drops an inactive job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, is_active: false }), false);
});

// --- normalizeTalent500Job ---------------------------------------------------

test("normalizeTalent500Job maps fields correctly", () => {
  const p = normalizeTalent500Job(company, baseJob);
  assert.equal(p.provider, "talent500");
  assert.equal(p.externalId, "a1b2c3d4-0000-0000-0000-000000000001");
  assert.equal(p.jobTitle, "Software Engineer I - QA");
  assert.equal(p.jobUrl, "https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950");
  assert.equal(p.location, "Bengaluru");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-06-24T14:51:54.811468+05:30").toISOString());
});

test("normalizeTalent500Job falls back to title when title_alias_1 is empty", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, title_alias_1: "" });
  assert.equal(p.jobTitle, "SDE1");
});

test("normalizeTalent500Job falls back to title when title_alias_1 is missing", () => {
  const job: Talent500Job = {
    id: baseJob.id,
    slug: baseJob.slug,
    title: "SDE1",
    location: baseJob.location,
    country: baseJob.country,
    is_remote: baseJob.is_remote,
    created_at: baseJob.created_at,
    status: baseJob.status,
    is_active: baseJob.is_active,
    is_job_displayable: baseJob.is_job_displayable,
  };
  const p = normalizeTalent500Job(company, job);
  assert.equal(p.jobTitle, "SDE1");
});

test("normalizeTalent500Job flags isRemote from is_remote true", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, is_remote: true, location: "Bengaluru" });
  assert.equal(p.isRemote, true);
});

test("normalizeTalent500Job flags isRemote from a REMOTE_RE-matching location", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, is_remote: null, location: "Remote - India" });
  assert.equal(p.isRemote, true);
});

test("normalizeTalent500Job maps an unparseable/absent created_at to null postedAt", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, created_at: null });
  assert.equal(p.postedAt, null);
});

// --- talent500SlugFromUrl -----------------------------------------------------

test("talent500SlugFromUrl derives the job slug from the public jobUrl", () => {
  assert.equal(
    talent500SlugFromUrl("https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950"),
    "software-engineer-i-qa-bengaluru-T500-26950",
  );
});

test("talent500SlugFromUrl throws on a URL with no path segment", () => {
  assert.throws(() => talent500SlugFromUrl("https://talent500.com/"), /could not derive job slug/);
});

// --- buildTalent500Jd ---------------------------------------------------------

test("buildTalent500Jd concatenates the JD-bearing fields in order and strips HTML", () => {
  const detail: Talent500Detail = {
    role_summary: "<p>Own the QA process for our platform.</p>",
    description: "<p>We are looking for a QA engineer.</p>",
    responsibilities: "<ul><li>Write test plans</li><li>Automate regressions</li></ul>",
    what_you_need_to_succeed: "<p>3+ years of QA experience.</p>",
    typical_workday: "<p>Should never appear in the JD.</p>",
    what_you_offer: "<p>Should never appear in the JD.</p>",
  };
  const jd = buildTalent500Jd(detail);
  assert.match(jd, /Own the QA process/);
  assert.match(jd, /looking for a QA engineer/);
  assert.match(jd, /Write test plans/);
  assert.match(jd, /3\+ years of QA experience/);
  assert.doesNotMatch(jd, /Should never appear/);
  assert.doesNotMatch(jd, /<p>|<ul>|<li>/);

  // order: role_summary before description before responsibilities before what_you_need_to_succeed
  const iRole = jd.indexOf("Own the QA process");
  const iDesc = jd.indexOf("looking for a QA engineer");
  const iResp = jd.indexOf("Write test plans");
  const iNeed = jd.indexOf("3+ years");
  assert.ok(iRole < iDesc);
  assert.ok(iDesc < iResp);
  assert.ok(iResp < iNeed);
});

test("buildTalent500Jd skips empty/missing fields", () => {
  const jd = buildTalent500Jd({
    role_summary: "",
    description: "<p>Only this field is present.</p>",
    responsibilities: null,
    what_you_need_to_succeed: undefined,
  });
  assert.match(jd, /Only this field is present/);
});

test("buildTalent500Jd throws when no JD-bearing field yields text", () => {
  assert.throws(
    () => buildTalent500Jd({ role_summary: "", description: null, responsibilities: undefined }),
    /no JD-bearing fields/,
  );
});
