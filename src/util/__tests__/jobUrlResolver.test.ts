import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveJobUrl } from "../jobUrlResolver.js";

test("greenhouse: boards.greenhouse.io/<slug>/jobs/<id>", () => {
  const r = resolveJobUrl("https://boards.greenhouse.io/acme/jobs/4123456");
  assert.deepEqual(r, { provider: "greenhouse", slugHint: "acme", externalId: "4123456" });
});

test("greenhouse: job-boards.greenhouse.io/<slug>/jobs/<id>", () => {
  const r = resolveJobUrl("https://job-boards.greenhouse.io/acme/jobs/4123457");
  assert.deepEqual(r, { provider: "greenhouse", slugHint: "acme", externalId: "4123457" });
});

test("greenhouse: embedded ?gh_jid= on the company's own careers page", () => {
  const r = resolveJobUrl("https://acme.com/careers?gh_jid=5987654");
  assert.equal(r.provider, "greenhouse");
  assert.equal(r.slugHint, null);
  assert.equal(r.externalId, "5987654");
  assert.match(r.hint ?? "", /company resolved by host/);
});

test("lever: jobs.lever.co/<slug>/<uuid>", () => {
  const uuid = "a1b2c3d4-e5f6-4789-a0bc-def012345678";
  const r = resolveJobUrl(`https://jobs.lever.co/acme/${uuid}`);
  assert.deepEqual(r, { provider: "lever", slugHint: "acme", externalId: uuid });
});

test("ashby: jobs.ashbyhq.com/<slug>/<id>", () => {
  const r = resolveJobUrl("https://jobs.ashbyhq.com/acme/9f3e1b2c-1234-4567-89ab-cdef01234567");
  assert.deepEqual(r, {
    provider: "ashby",
    slugHint: "acme",
    externalId: "9f3e1b2c-1234-4567-89ab-cdef01234567",
  });
});

test("smartrecruiters: jobs.smartrecruiters.com/<Company>/<id>-<title-slug>", () => {
  const r = resolveJobUrl("https://jobs.smartrecruiters.com/Bosch/743999967705961-junior-software-engineer");
  assert.deepEqual(r, { provider: "smartrecruiters", slugHint: "Bosch", externalId: "743999967705961" });
});

test("workday: tenant + requisition slug, external_id mismatch hinted", () => {
  const r = resolveJobUrl(
    "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Bengaluru---Karnataka/Software-Engineer_R12345",
  );
  assert.equal(r.provider, "workday");
  assert.equal(r.slugHint, "acme");
  assert.equal(r.externalId, "Software-Engineer_R12345");
  assert.match(r.hint ?? "", /job_url LIKE lookup/);
});

test("workday: no /job/ segment -> externalId null", () => {
  const r = resolveJobUrl("https://acme.wd1.myworkdayjobs.com/en-US/External");
  assert.equal(r.provider, "workday");
  assert.equal(r.slugHint, "acme");
  assert.equal(r.externalId, null);
});

test("keka: <tenant>.keka.com/careers/jobdetails/<id>", () => {
  const r = resolveJobUrl("https://acme.keka.com/careers/jobdetails/98765");
  assert.deepEqual(r, { provider: "keka", slugHint: "acme", externalId: "98765" });
});

test("darwinbox: candidatev2 jobDetails/<id>", () => {
  const r = resolveJobUrl("https://acme.darwinbox.in/ms/candidatev2/acmetoken/careers/jobDetails/a1b2c3");
  assert.deepEqual(r, { provider: "darwinbox", slugHint: "acme", externalId: "a1b2c3" });
});

test("darwinbox: legacy candidate-ms careers/<id> (LIKE-fallback hinted)", () => {
  const r = resolveJobUrl("https://acme.darwinbox.com/ms/candidate/careers/a1b2c3");
  assert.equal(r.provider, "darwinbox");
  assert.equal(r.slugHint, "acme");
  assert.equal(r.externalId, "a1b2c3");
  assert.match(r.hint ?? "", /job_url LIKE lookup/);
});

test("zohorecruit: trailing numeric id segment", () => {
  const r = resolveJobUrl("https://acme.zohorecruit.com/jobs/Careers/578219000012345678/Senior-Engineer");
  assert.deepEqual(r, {
    provider: "zohorecruit",
    slugHint: "acme",
    externalId: "578219000012345678",
  });
});

test("freshteam: /jobs/<id>/<slug>", () => {
  const r = resolveJobUrl("https://acme.freshteam.com/jobs/abc123/senior-engineer");
  assert.deepEqual(r, { provider: "freshteam", slugHint: "acme", externalId: "abc123" });
});

test("oracle: *.oraclecloud.com with /job/<id>", () => {
  const r = resolveJobUrl(
    "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345",
  );
  assert.deepEqual(r, {
    provider: "oracle",
    slugHint: "acme.fa.us2.oraclecloud.com",
    externalId: "12345",
  });
});

test("eightfold: /careers/job/<id>", () => {
  const r = resolveJobUrl("https://acme.eightfold.ai/careers/job/998877");
  assert.deepEqual(r, { provider: "eightfold", slugHint: "acme", externalId: "998877" });
});

test("eightfold: ?pid=<id> (LIKE-fallback hinted)", () => {
  const r = resolveJobUrl("https://acme.eightfold.ai/careers?domain=acme.com&pid=998877");
  assert.equal(r.provider, "eightfold");
  assert.equal(r.slugHint, "acme");
  assert.equal(r.externalId, "998877");
  assert.match(r.hint ?? "", /job_url LIKE lookup/);
});

test("successfactors-shaped: /job/<slug>/<digits>/ (sfcsb or successfactors, resolve by host)", () => {
  const r = resolveJobUrl("https://careers.acme.com/job/Bengaluru-Software-Engineer/372397-en_US/");
  assert.equal(r.provider, null);
  assert.equal(r.slugHint, "careers.acme.com");
  assert.equal(r.externalId, "372397");
  assert.match(r.hint ?? "", /sfcsb or successfactors/);
});

test("bamboohr: <tenant>.bamboohr.com/careers/<id>", () => {
  const r = resolveJobUrl("https://acme.bamboohr.com/careers/456");
  assert.deepEqual(r, { provider: "bamboohr", slugHint: "acme", externalId: "456" });
});

test("unresolvable URL: no known ATS pattern matched", () => {
  const r = resolveJobUrl("https://example.com/careers/some-role");
  assert.equal(r.provider, null);
  assert.equal(r.slugHint, null);
  assert.equal(r.externalId, null);
  assert.match(r.hint ?? "", /no known ATS pattern matched/);
});

test("non-URL string: not a valid URL", () => {
  const r = resolveJobUrl("this is not a url at all");
  assert.equal(r.provider, null);
  assert.equal(r.slugHint, null);
  assert.equal(r.externalId, null);
  assert.match(r.hint ?? "", /not a valid URL/);
});
