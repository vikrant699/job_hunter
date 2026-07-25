// src/ats/turbohire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  turboHireAccountOrigin,
  turboHireCareerPageUrl,
  turboHireFilteredJobsUrl,
  TURBOHIRE_TOKEN_URL,
  parseTurboHireLocation,
  normalizeTurboHire,
  mergeTurboHirePages,
} from "./turbohire.js";
import type { TurboHireJob } from "./turbohire.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";

const company: AdapterCompany = {
  provider: "turbohire", slug: "flipkart", name: "Flipkart",
  careersUrl: "https://flipkart.turbohire.co/careerpage/4d757ba0-3d57-448a-b82c-238ed87ac90f",
  tenantUrl: "https://flipkart.turbohire.co/careerpage/4d757ba0-3d57-448a-b82c-238ed87ac90f",
  apiMeta: { orgId: "4d757ba0-3d57-448a-b82c-238ed87ac90f" },
};

const job: TurboHireJob = {
  JobId: "ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e",
  JobTitle: "AM for Kerala",
  Department: "Projects (D2037)",
  Location: '[{"Address":"Bengaluru, Karnataka, India","PlaceId":null}]',
  JobDescV2: "<p></p><ul><li>Able to lead a team of Engineers</li></ul>",
  PublishedDate: "2026-06-15T07:23:10.588362Z",
  UpdatedDate: "2026-06-30T07:16:08.9466667",
  Type: "UNSPECIFIED",
};

test("turboHireAccountOrigin derives the origin from careersUrl", () => {
  assert.equal(turboHireAccountOrigin(company), "https://flipkart.turbohire.co");
});

test("turboHireCareerPageUrl builds the /careerpage/<orgId> URL", () => {
  assert.equal(
    turboHireCareerPageUrl(company, "4d757ba0-3d57-448a-b82c-238ed87ac90f"),
    "https://flipkart.turbohire.co/careerpage/4d757ba0-3d57-448a-b82c-238ed87ac90f",
  );
});

test("turboHireFilteredJobsUrl builds the thapi endpoint with orgId query param", () => {
  assert.equal(
    turboHireFilteredJobsUrl("4d757ba0-3d57-448a-b82c-238ed87ac90f"),
    "https://thapi.azurewebsites.net/api/careerpagev2/filteredjobs?orgId=4d757ba0-3d57-448a-b82c-238ed87ac90f",
  );
});

test("TURBOHIRE_TOKEN_URL is the anon-token endpoint", () => {
  assert.equal(TURBOHIRE_TOKEN_URL, "https://thapi.azurewebsites.net/api/token/noauth");
});

test("parseTurboHireLocation extracts Address from the JSON-encoded array", () => {
  assert.equal(
    parseTurboHireLocation('[{"Address":"Bengaluru, Karnataka, India","PlaceId":null}]'),
    "Bengaluru, Karnataka, India",
  );
});

test("parseTurboHireLocation joins multiple addresses", () => {
  assert.equal(
    parseTurboHireLocation('[{"Address":"Bengaluru, India"},{"Address":"Pune, India"}]'),
    "Bengaluru, India; Pune, India",
  );
});

test("parseTurboHireLocation returns null for null/empty/malformed input", () => {
  assert.equal(parseTurboHireLocation(null), null);
  assert.equal(parseTurboHireLocation(undefined), null);
  assert.equal(parseTurboHireLocation(""), null);
  assert.equal(parseTurboHireLocation("not json"), null);
  assert.equal(parseTurboHireLocation("{}"), null); // not an array
});

test("normalizeTurboHire maps fields, strips JD HTML, converts location + posted date", () => {
  const p = normalizeTurboHire(company, job);
  assert.equal(p.provider, "turbohire");
  assert.equal(p.externalId, "ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e");
  assert.equal(p.companySlug, "flipkart");
  assert.equal(p.jobTitle, "AM for Kerala");
  assert.equal(p.jobUrl, "https://flipkart.turbohire.co/job/publicjobs/ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText.includes("Able to lead a team of Engineers"), true);
  assert.equal(p.jdText.includes("<li>"), false); // HTML stripped
  assert.equal(p.postedAt, "2026-06-15T07:23:10.588Z");
});

test("normalizeTurboHire falls back to UpdatedDate when PublishedDate is absent, treating it as UTC even without a Z suffix", () => {
  const p = normalizeTurboHire(company, { ...job, PublishedDate: null });
  assert.equal(p.postedAt, "2026-06-30T07:16:08.946Z");
});

test("normalizeTurboHire marks remote via location/type text", () => {
  const p = normalizeTurboHire(company, { ...job, Type: "REMOTE" });
  assert.equal(p.isRemote, true);
});

function page(jobs: TurboHireJob[], total: number | null = null) {
  return { Total: total, Result: jobs };
}

test("mergeTurboHirePages accumulates valid pages in order", () => {
  const out: NormalizedPosting[] = [];
  mergeTurboHirePages(company, out, [page([job]), page([{ ...job, JobId: "2" }])], 2);
  assert.deepEqual(out.map((p) => p.externalId), ["ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e", "2"]);
});

test("mergeTurboHirePages stops once total is reached", () => {
  const out: NormalizedPosting[] = [];
  mergeTurboHirePages(company, out, [page([job]), page([{ ...job, JobId: "2" }])], 1);
  assert.deepEqual(out.map((p) => p.externalId), ["ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e"]);
});

// The filteredjobs endpoint ignores pageNumber/pageSize and returns the whole
// board in one call (verified live on all 10 tenants 2026-07-25: Total ===
// Result.length). Should a tenant ever report a Total larger than one response
// while still ignoring pageNumber, every "next page" would repeat page 1 — so
// the merge must not stack the same job twice on the way to Total.
test("mergeTurboHirePages ignores a repeated page instead of duplicating jobs", () => {
  const out: NormalizedPosting[] = [];
  mergeTurboHirePages(company, out, [page([job]), page([job]), page([{ ...job, JobId: "2" }])], 3);
  assert.deepEqual(out.map((p) => p.externalId), ["ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e", "2"]);
});

test("mergeTurboHirePages does not re-add a job already collected from page 1", () => {
  const out: NormalizedPosting[] = [normalizeTurboHire(company, job)];
  mergeTurboHirePages(company, out, [page([job, { ...job, JobId: "2" }])], 3);
  assert.deepEqual(out.map((p) => p.externalId), ["ef888dcf-c65a-4fd2-a10e-b8dd2b7c131e", "2"]);
});

test("mergeTurboHirePages stops on an empty page", () => {
  const out: NormalizedPosting[] = [];
  mergeTurboHirePages(company, out, [page([]), page([{ ...job, JobId: "2" }])], 5);
  assert.deepEqual(out, []);
});

test("mergeTurboHirePages throws (not warn+truncate) on a mid-pagination schema mismatch", () => {
  const out: NormalizedPosting[] = [{ ...normalizeTurboHire(company, job) }];
  assert.throws(
    () => mergeTurboHirePages(company, out, [{ Total: 5, Result: "not-an-array" }], 5),
    /turbohire page \(fetched \d+\/\d+ so far\) response failed schema for flipkart/,
  );
  // Must not silently keep only the partial list — the throw happens before
  // any further mutation from this malformed page.
  assert.equal(out.length, 1);
});
