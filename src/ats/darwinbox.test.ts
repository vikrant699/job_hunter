// src/ats/darwinbox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDarwinbox, darwinboxTenantBase, mergeDarwinboxPages } from "./darwinbox.js";
import type { DarwinboxJob } from "./darwinbox.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";

const company: AdapterCompany = {
  provider: "darwinbox", slug: "emeritus", name: "Emeritus",
  careersUrl: "https://emeritus.darwinbox.in/ms/candidate/careers",
  tenantUrl: "https://emeritus.darwinbox.in/ms/candidate/careers", apiMeta: null,
};

const job: DarwinboxJob = {
  id: "a66faa21bc4531", title: "Team Leader - Sales", designation_display_name: "Team Leader",
  officelocation_show_arr: "Mumbai, Maharashtra, India", job_posting_on: 1780511400,
  created_on: "2024-09-30T13:05:31.000Z",
};

test("darwinboxTenantBase derives the origin", () => {
  assert.equal(darwinboxTenantBase(company), "https://emeritus.darwinbox.in");
});

test("normalizeDarwinbox maps fields, prefers title, converts epoch", () => {
  const p = normalizeDarwinbox(company, job);
  assert.equal(p.provider, "darwinbox");
  assert.equal(p.externalId, "a66faa21bc4531");
  assert.equal(p.jobTitle, "Team Leader - Sales");
  assert.equal(p.location, "Mumbai, Maharashtra, India");
  assert.equal(p.postedAt, new Date(1780511400 * 1000).toISOString());
});

test("normalizeDarwinbox falls back to designation when title empty", () => {
  const p = normalizeDarwinbox(company, { ...job, title: "" });
  assert.equal(p.jobTitle, "Team Leader");
});

function page(jobs: DarwinboxJob[]) {
  return { status: "ok", message: { jobscount: null, jobs } };
}

test("mergeDarwinboxPages accumulates valid pages in order", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([job]), page([{ ...job, id: "2" }])], 2);
  assert.deepEqual(out.map((p) => p.externalId), ["a66faa21bc4531", "2"]);
});

test("mergeDarwinboxPages stops once total is reached", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([job]), page([{ ...job, id: "2" }])], 1);
  assert.deepEqual(out.map((p) => p.externalId), ["a66faa21bc4531"]);
});

test("mergeDarwinboxPages stops on an empty page", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([]), page([{ ...job, id: "2" }])], 5);
  assert.deepEqual(out, []);
});

test("mergeDarwinboxPages throws (not warn+truncate) on a mid-pagination schema mismatch", () => {
  const out: NormalizedPosting[] = [{ ...normalizeDarwinbox(company, job) }];
  assert.throws(
    () => mergeDarwinboxPages(company, out, [{ status: "ok", message: { jobs: "not-an-array" } }], 5),
    /darwinbox: page schema mismatch mid-pagination for emeritus/,
  );
  // Must not silently keep only the partial list — the throw happens before
  // any further mutation from this malformed page.
  assert.equal(out.length, 1);
});
