// src/ats/advantageclub.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { advantageClubListUrl, advantageClubDetailUrl, advantageClubJobUrl, normalizeAdvantageClubJob, buildAdvantageClubJd } from "../advantageclub.js";
import type { AdvantageClubJob, AdvantageClubDetail } from "../advantageclub.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "advantageclub",
  slug: "advantage-club",
  name: "Advantage Club",
  careersUrl: "https://www.advantageclub.ai/pages/ac_career",
  tenantUrl: null,
  apiMeta: null,
};

test("advantageClubListUrl builds a 1-based page/per_page URL", () => {
  assert.equal(
    advantageClubListUrl(1, 50),
    "https://app.advantageclub.ai/api/v1/career/jobs?page=1&per_page=50",
  );
  assert.equal(
    advantageClubListUrl(2),
    "https://app.advantageclub.ai/api/v1/career/jobs?page=2&per_page=50",
  );
});

test("advantageClubDetailUrl builds the numeric-id job-detail endpoint", () => {
  assert.equal(advantageClubDetailUrl(17), "https://app.advantageclub.ai/api/v1/career/jobs/17");
});

test("advantageClubJobUrl builds the public vacancy_details page URL", () => {
  assert.equal(
    advantageClubJobUrl(17),
    "https://www.advantageclub.ai/pages/ac_career/vacancy_details/17",
  );
});

const baseJob: AdvantageClubJob = {
  id: 17,
  slug: "op1",
  title: "Senior Customer Success Manager",
  location: "Gurugram",
  remote_policy: "onsite",
  short_description: "Relevant degree (MBA preferred) with 1-4 years of B2B SaaS experience.",
  published_at: "2026-05-19T00:00:00.000Z",
};

test("normalizeAdvantageClubJob maps fields correctly", () => {
  const p = normalizeAdvantageClubJob(company, baseJob);
  assert.equal(p.provider, "advantageclub");
  assert.equal(p.externalId, "17");
  assert.equal(p.jobTitle, "Senior Customer Success Manager");
  assert.equal(p.jobUrl, "https://www.advantageclub.ai/pages/ac_career/vacancy_details/17");
  assert.equal(p.location, "Gurugram");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-05-19T00:00:00.000Z").toISOString());
});

test("normalizeAdvantageClubJob falls back to empty title when title is missing", () => {
  const p = normalizeAdvantageClubJob(company, { ...baseJob, title: null });
  assert.equal(p.jobTitle, "");
});

test("normalizeAdvantageClubJob flags isRemote from remote_policy === remote", () => {
  const p = normalizeAdvantageClubJob(company, { ...baseJob, remote_policy: "Remote", location: "Gurugram" });
  assert.equal(p.isRemote, true);
});

test("normalizeAdvantageClubJob flags isRemote from a REMOTE_RE-matching location", () => {
  const p = normalizeAdvantageClubJob(company, { ...baseJob, remote_policy: "onsite", location: "Remote - India" });
  assert.equal(p.isRemote, true);
});

test("normalizeAdvantageClubJob maps an unparseable/absent published_at to null postedAt", () => {
  const p = normalizeAdvantageClubJob(company, { ...baseJob, published_at: null });
  assert.equal(p.postedAt, null);
});

test("buildAdvantageClubJd concatenates the JD-bearing fields in order and strips HTML", () => {
  const detail: AdvantageClubDetail = {
    id: 17,
    description: "We are seeking an experienced Customer Success Manager.",
    responsibilities: "<ul><li>Own client relationships</li><li>Drive retention</li></ul>",
    skills_required: "Strong CRM proficiency",
    experience_qualification: "1-4 years of B2B SaaS experience",
    education_qualification: "Bachelor's degree",
    short_description: "Should never appear in the JD.",
  };
  const jd = buildAdvantageClubJd(detail);
  assert.match(jd, /experienced Customer Success Manager/);
  assert.match(jd, /Own client relationships/);
  assert.match(jd, /Strong CRM proficiency/);
  assert.match(jd, /1-4 years of B2B SaaS experience/);
  assert.match(jd, /Bachelor's degree/);
  assert.doesNotMatch(jd, /<ul>|<li>/);

  // order: description, responsibilities, skills_required, experience_qualification, education_qualification, short_description
  const iDesc = jd.indexOf("experienced Customer Success Manager");
  const iResp = jd.indexOf("Own client relationships");
  const iSkills = jd.indexOf("Strong CRM proficiency");
  const iExp = jd.indexOf("1-4 years");
  const iEdu = jd.indexOf("Bachelor's degree");
  assert.ok(iDesc < iResp);
  assert.ok(iResp < iSkills);
  assert.ok(iSkills < iExp);
  assert.ok(iExp < iEdu);
});

test("buildAdvantageClubJd skips empty/missing fields", () => {
  const jd = buildAdvantageClubJd({
    id: 17,
    description: "",
    responsibilities: "Only this field is present.",
    skills_required: null,
    experience_qualification: undefined,
    education_qualification: null,
  });
  assert.match(jd, /Only this field is present/);
});

test("buildAdvantageClubJd falls back to short_description when every other field is empty", () => {
  const jd = buildAdvantageClubJd({
    id: 17,
    description: null,
    responsibilities: null,
    skills_required: null,
    experience_qualification: null,
    education_qualification: null,
    short_description: "Only the short description survives.",
  });
  assert.match(jd, /Only the short description survives/);
});

test("buildAdvantageClubJd throws when no JD-bearing field yields text", () => {
  assert.throws(
    () => buildAdvantageClubJd({ id: 17, description: "", responsibilities: null, skills_required: undefined }),
    /no JD-bearing fields/,
  );
});
