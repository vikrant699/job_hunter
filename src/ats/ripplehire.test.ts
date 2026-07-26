// src/ats/ripplehire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  extractRipplehireToken,
  ripplehireListUrl,
  ripplehireListBody,
  ripplehireJdUrl,
  ripplehireBoardUrl,
  normalizeRipplehire,
  parseRipplehireJd,
  RipplehireListSchema,
  RipplehireJdSchema,
  type RipplehireJob,
} from "./ripplehire.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "ripplehire",
  slug: "tatasteel",
  name: "Tata Steel",
  careersUrl: "https://tatasteel.ripplehire.com/candidate/careers",
  tenantUrl: null,
  apiMeta: null,
};

const TOKEN = "DFwOOO2VFAGlqLQoae5h";

const ListParamsSchema = z.object({
  page: z.number(),
  search: z.string(),
  token: z.string(),
  source: z.string(),
  pagesize: z.number(),
});

// Live shapes confirmed from tatasteel.ripplehire.com and usource.ripplehire.com.
const JOB_WITH_CODE: RipplehireJob = {
  jobSeq: "640521",
  jobId: "640521",
  jobTitle: "SNTI ITI TA",
  jobCode: "SNTIITITATSK",
  locations: "Jajpur",
  jobLocation: null,
  jobPostingDate: null,
  createDttm: null,
};

const JOB_NO_CODE: RipplehireJob = {
  jobSeq: "61661",
  jobId: "61661",
  jobTitle: "Lead I - Business Analysis",
  jobCode: "",
  locations: "Chennai",
  jobLocation: null,
  jobPostingDate: null,
  createDttm: null,
};

test("extractRipplehireToken reads the token query param from the post-redirect URL", () => {
  assert.equal(
    extractRipplehireToken("https://tatasteel.ripplehire.com/candidate/?token=DFwOOO2VFAGlqLQoae5h&source=CAREERSITE"),
    "DFwOOO2VFAGlqLQoae5h",
  );
  assert.equal(extractRipplehireToken("https://tatasteel.ripplehire.com/candidate/careers"), null);
  assert.equal(extractRipplehireToken("not a url"), null);
});

test("ripplehireListUrl builds the fixed search endpoint from the tenant origin", () => {
  assert.equal(
    ripplehireListUrl("https://tatasteel.ripplehire.com"),
    "https://tatasteel.ripplehire.com/candidate/candidatejobsearch",
  );
});

test("ripplehireListBody encodes the careerSiteUrlParams JSON blob + lang", () => {
  const body = ripplehireListBody(TOKEN, 0);
  assert.equal(body.lang, "en");
  assert.ok(body.careerSiteUrlParams);
  const params = ListParamsSchema.parse(JSON.parse(body.careerSiteUrlParams));
  assert.deepEqual(params, { page: 0, search: "*:*", token: TOKEN, source: "CAREERSITE", pagesize: 100 });
});

test("ripplehireListBody advances the page number and honors a custom pagesize", () => {
  const body = ripplehireListBody(TOKEN, 3, 50);
  assert.ok(body.careerSiteUrlParams);
  const params = ListParamsSchema.parse(JSON.parse(body.careerSiteUrlParams));
  assert.equal(params.page, 3);
  assert.equal(params.pagesize, 50);
});

test("ripplehireJdUrl builds the per-job detail endpoint", () => {
  assert.equal(
    ripplehireJdUrl("https://tatasteel.ripplehire.com", TOKEN, "640521"),
    "https://tatasteel.ripplehire.com/candidate/candidatejobdetail?token=DFwOOO2VFAGlqLQoae5h&jobSeq=640521&source=CAREERSITE&lang=en",
  );
});

test("ripplehireBoardUrl builds the token-bearing candidate board link", () => {
  assert.equal(
    ripplehireBoardUrl("https://tatasteel.ripplehire.com", TOKEN),
    "https://tatasteel.ripplehire.com/candidate/?token=DFwOOO2VFAGlqLQoae5h&source=CAREERSITE",
  );
});

test("normalizeRipplehire maps fields from a live-shaped job", () => {
  const p = normalizeRipplehire(company, TOKEN, JOB_WITH_CODE);
  assert(p);
  assert.equal(p.provider, "ripplehire");
  assert.equal(p.externalId, "640521");
  assert.equal(p.companySlug, "tatasteel");
  assert.equal(p.companyName, "Tata Steel");
  assert.equal(p.jobTitle, "SNTI ITI TA");
  assert.equal(p.jobUrl, "https://tatasteel.ripplehire.com/candidate/?token=DFwOOO2VFAGlqLQoae5h&source=CAREERSITE");
  assert.equal(p.location, "Jajpur");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, ""); // JD populated by fetchJd
  assert.equal(p.postedAt, null);
});

test("normalizeRipplehire falls back to jobId when jobSeq is missing, and detects remote locations", () => {
  const p = normalizeRipplehire(company, TOKEN, {
    ...JOB_NO_CODE,
    jobSeq: null,
    jobId: "61661",
    locations: "Remote - India",
  });
  assert(p);
  assert.equal(p.externalId, "61661");
  assert.equal(p.location, "Remote - India");
  assert.equal(p.isRemote, true);
});

test("normalizeRipplehire returns null when both jobSeq and jobId are absent", () => {
  assert.equal(normalizeRipplehire(company, TOKEN, { jobTitle: "No Id" }), null);
  assert.equal(normalizeRipplehire(company, TOKEN, { jobSeq: null, jobId: null }), null);
});

test("normalizeRipplehire falls back to jobLocation then null; parses a real posted date", () => {
  const fallback = normalizeRipplehire(company, TOKEN, {
    jobSeq: "1",
    locations: null,
    jobLocation: "Mumbai",
  });
  assert(fallback);
  assert.equal(fallback.location, "Mumbai");

  const none = normalizeRipplehire(company, TOKEN, { jobSeq: "2" });
  assert(none);
  assert.equal(none.location, null);
  assert.equal(none.isRemote, false);

  const dated = normalizeRipplehire(company, TOKEN, { jobSeq: "3", jobPostingDate: "2026-07-01" });
  assert(dated);
  assert.equal(dated.postedAt, new Date("2026-07-01").toISOString());
});

test("RipplehireListSchema parses the wrapper and totalJobCount pagination math", () => {
  const raw = {
    startJobIndex: 0,
    maxJobSize: 100,
    totalJobCount: 1355,
    jobVoList: [JOB_WITH_CODE, JOB_NO_CODE],
  };
  const parsed = RipplehireListSchema.safeParse(raw);
  assert.ok(parsed.success);
  assert.equal(parsed.data.totalJobCount, 1355);
  assert.equal(parsed.data.jobVoList?.length, 2);
  // 1355 records at page size 100 -> 14 pages.
  const total = parsed.data.totalJobCount;
  assert(typeof total === "number");
  assert.equal(Math.ceil(total / 100), 14);
});

test("empty board: jobVoList present but empty", () => {
  const parsed = RipplehireListSchema.safeParse({ totalJobCount: 0, jobVoList: [] });
  assert.ok(parsed.success);
  assert.equal(parsed.data.jobVoList?.length, 0);
});

test("empty board: jobVoList null (some tenants omit the array entirely)", () => {
  const parsed = RipplehireListSchema.safeParse({ totalJobCount: 0, jobVoList: null });
  assert.ok(parsed.success);
  assert.equal(parsed.data.jobVoList, null);
});

test("malformed list response fails the schema", () => {
  assert.equal(RipplehireListSchema.safeParse({ jobVoList: "nope" }).success, false);
  assert.equal(RipplehireListSchema.safeParse("garbage").success, false);
  assert.equal(RipplehireListSchema.safeParse(null).success, false);
});

test("parseRipplehireJd extracts jobVO.jobDesc and strips HTML", () => {
  const raw = {
    jobVO: {
      jobDesc: "<p><strong>Purpose</strong></p><ul><li>Own delivery</li><li>Ship fast</li></ul>",
    },
  };
  const jd = parseRipplehireJd(raw);
  assert.match(jd, /Purpose/);
  assert.match(jd, /Own delivery/);
  assert.match(jd, /Ship fast/);
  assert.doesNotMatch(jd, /<p>|<li>|<strong>/i);
});

test("parseRipplehireJd returns empty string when the description is absent or malformed", () => {
  assert.equal(parseRipplehireJd({ jobVO: {} }), "");
  assert.equal(parseRipplehireJd({ jobVO: null }), "");
  assert.equal(parseRipplehireJd({}), "");
  assert.equal(parseRipplehireJd("garbage"), "");
  assert.equal(RipplehireJdSchema.safeParse("garbage").success, false);
});
