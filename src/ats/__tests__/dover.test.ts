// src/ats/dover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  doverCareersPageSlugUrl,
  doverJobsUrl,
  doverJdUrl,
  doverJobUrl,
  resolveDoverClientId,
  normalizeDover,
  extractDoverJd,
} from "../dover.js";
import type { DoverJob, DoverJobDescription } from "../dover.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "dover",
  slug: "codingal",
  name: "Codingal",
  careersUrl: "https://app.dover.com/jobs/codingal",
  tenantUrl: null,
  apiMeta: null,
};

// Real shape captured live from
// GET https://app.dover.com/api/v1/careers-page/<clientId>/jobs
const job: DoverJob = {
  id: "23891f33-004d-42ab-a720-0647b834dee0",
  title: "Business Development Associate ",
  locations: [
    {
      location_type: "IN_OFFICE",
      location_option: {
        display_name: "Bengaluru, India",
        city: "Bengaluru",
        state: "Karnataka",
        country: "IN",
      },
      name: "Bengaluru, India",
      is_primary: false,
    },
  ],
  workplace_type: "ONSITE",
  is_published: true,
  is_sample: false,
};

test("doverCareersPageSlugUrl builds the slug-resolution URL", () => {
  assert.equal(
    doverCareersPageSlugUrl("codingal"),
    "https://app.dover.com/api/v1/careers-page-slug/codingal",
  );
});

test("doverJobsUrl builds the limit/offset paged jobs URL for a client id", () => {
  assert.equal(
    doverJobsUrl("9d19c96c-5e33-4332-8c9a-623e55540671", 0, 100),
    "https://app.dover.com/api/v1/careers-page/9d19c96c-5e33-4332-8c9a-623e55540671/jobs?limit=100&offset=0",
  );
});

test("doverJdUrl builds the per-job description URL", () => {
  assert.equal(
    doverJdUrl("23891f33-004d-42ab-a720-0647b834dee0"),
    "https://app.dover.com/api/v1/jobs/23891f33-004d-42ab-a720-0647b834dee0/get_job_description",
  );
});

test("doverJobUrl builds the public apply URL from slug + job id", () => {
  assert.equal(
    doverJobUrl("codingal", "23891f33-004d-42ab-a720-0647b834dee0"),
    "https://app.dover.com/apply/codingal/23891f33-004d-42ab-a720-0647b834dee0",
  );
});

test("resolveDoverClientId returns the cached apiMeta.clientId without any fetch", async () => {
  const c: AdapterCompany = { ...company, apiMeta: { clientId: "cached-id" } };
  const id = await resolveDoverClientId(c);
  assert.equal(id, "cached-id");
});

test("normalizeDover maps fields: trimmed title, apply URL, primary location, ONSITE not remote", () => {
  const p = normalizeDover(company, job);
  assert.equal(p.provider, "dover");
  assert.equal(p.externalId, "23891f33-004d-42ab-a720-0647b834dee0");
  assert.equal(p.jobTitle, "Business Development Associate");
  assert.equal(p.jobUrl, "https://app.dover.com/apply/codingal/23891f33-004d-42ab-a720-0647b834dee0");
  assert.equal(p.location, "Bengaluru, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, ""); // two-phase — fetchJd fills this in
  assert.equal(p.postedAt, null);
});

test("normalizeDover honors workplace_type REMOTE even with an onsite-looking location name", () => {
  const p = normalizeDover(company, { ...job, workplace_type: "REMOTE" });
  assert.equal(p.isRemote, true);
});

test("normalizeDover falls back to locations[0] when no location is flagged primary", () => {
  const p = normalizeDover(company, job);
  assert.equal(p.location, "Bengaluru, India");
});

// Real shape captured live from
// GET https://app.dover.com/api/v1/jobs/<jobId>/get_job_description (codingal)
test("extractDoverJd prefers user_facing_description, HTML-stripped", () => {
  const detail: DoverJobDescription = {
    user_facing_description: "<p><strong>About the role</strong></p><p>Teach kids to code.</p>",
    user_provided_description: "<p>raw employer draft, superseded</p>",
    generated_description: null,
    external_url: null,
  };
  const jd = extractDoverJd(detail);
  assert.match(jd, /About the role/);
  assert.match(jd, /Teach kids to code/);
  assert.doesNotMatch(jd, /superseded/);
  assert.doesNotMatch(jd, /<p>|<strong>/);
});

test("extractDoverJd falls back to user_provided_description when user_facing_description is empty", () => {
  const detail: DoverJobDescription = {
    user_facing_description: "",
    user_provided_description:
      "<p><strong>Codingal is on a mission to inspire school kids to fall in love with coding.</strong></p>",
    generated_description: {
      about_the_role: null,
      job_mandates: null,
      qualifications: null,
      about_the_company: null,
      additional_information: null,
    },
    external_url: null,
  };
  const jd = extractDoverJd(detail);
  assert.match(jd, /inspire school kids/);
  assert.doesNotMatch(jd, /<p>|<strong>/);
});

test("extractDoverJd assembles generated_description sections when no raw HTML is set", () => {
  const detail: DoverJobDescription = {
    user_facing_description: null,
    user_provided_description: null,
    generated_description: {
      about_the_company: "We build things.",
      about_the_role: "You will build things too.",
      job_mandates: null,
      qualifications: "5 years experience.",
      additional_information: null,
    },
    external_url: null,
  };
  const jd = extractDoverJd(detail);
  assert.match(jd, /We build things/);
  assert.match(jd, /You will build things too/);
  assert.match(jd, /5 years experience/);
});

test("extractDoverJd returns empty string when nothing is populated", () => {
  const detail: DoverJobDescription = {
    user_facing_description: null,
    user_provided_description: null,
    generated_description: null,
    external_url: "https://example.com/apply",
  };
  assert.equal(extractDoverJd(detail), "");
});
