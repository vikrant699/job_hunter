// src/ats/ainterviews.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ainterviewsAdapter, ainterviewsListUrl, normalizeAinterviews, AinterviewsJobSchema } from "../ainterviews.js";
import type { AinterviewsJob } from "../ainterviews.js";
import type { AdapterCompany } from "../../types.js";

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

const company: AdapterCompany = {
  provider: "ainterviews",
  slug: "lenskart_ho",
  name: "Lenskart",
  careersUrl: "https://ainterviews.com/job_board/lenskart_ho/",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed real items from GET /api/job_board/lenskart_ho/jobs/
const job1: AinterviewsJob = {
  id: 23,
  title: "Product Manager",
  description: "<div class=\"ql-align-justify\">The person will be managing the Lenskart products.</div>",
  location: "Bangalore",
  posted_date: "2025-10-22T07:04:42.168972+00:00",
  apply_url: "/job_board/lenskart_ho/job/23/",
};

const job2: AinterviewsJob = {
  id: 24,
  title: "CEO Office",
  description: "<div><strong>Why This Role Exists</strong></div><div>Demanding role.</div>",
  location: "Delhi",
  posted_date: "2025-10-22T07:04:42.168972+00:00",
  apply_url: "/job_board/lenskart_ho/job/24/",
};

test("ainterviewsListUrl builds the tenant board API URL against the fixed origin", () => {
  assert.equal(ainterviewsListUrl("lenskart_ho"), "https://ainterviews.com/api/job_board/lenskart_ho/jobs/");
});

test("AinterviewsJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(AinterviewsJobSchema.safeParse(job1).success);
  assert.ok(AinterviewsJobSchema.safeParse({ id: 1, title: "y" }).success);
  assert.equal(AinterviewsJobSchema.safeParse({ title: "no id" }).success, false);
  assert.equal(AinterviewsJobSchema.safeParse({ id: 1 }).success, false); // title required
});

test("normalizeAinterviews maps fields, strips HTML JD, resolves relative apply_url", () => {
  const p = normalizeAinterviews(company, job1);
  assert.equal(p.provider, "ainterviews");
  assert.equal(p.externalId, "23");
  assert.equal(p.companySlug, "lenskart_ho");
  assert.equal(p.jobTitle, "Product Manager");
  assert.equal(p.jobUrl, "https://ainterviews.com/job_board/lenskart_ho/job/23/");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, "2025-10-22T07:04:42.168972+00:00");
  assert.match(p.jdText, /The person will be managing the Lenskart products/);
  assert.doesNotMatch(p.jdText, /<div/);
});

test("normalizeAinterviews honors an already-absolute apply_url", () => {
  const p = normalizeAinterviews(company, { ...job1, apply_url: "https://ainterviews.com/job_board/lenskart_ho/job/23/?ref=x" });
  assert.equal(p.jobUrl, "https://ainterviews.com/job_board/lenskart_ho/job/23/?ref=x");
});

test("normalizeAinterviews synthesizes the board URL when apply_url is absent", () => {
  const p = normalizeAinterviews(company, { ...job1, apply_url: null });
  assert.equal(p.jobUrl, "https://ainterviews.com/job_board/lenskart_ho/");
});

test("normalizeAinterviews flags remote via REMOTE_RE against location, null location -> not remote", () => {
  assert.equal(normalizeAinterviews(company, { ...job1, location: "Remote" }).isRemote, true);
  const p = normalizeAinterviews(company, { ...job1, location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("ainterviewsAdapter.listPostings maps a 2-job board with inline JD (no fetchJd call needed)", async () => {
  stubFetch(async () => Response.json({ jobs: [job1, job2], filters: {} }));
  try {
    const postings = await ainterviewsAdapter.listPostings(company);
    assert.equal(postings.length, 2);
    assert.equal(postings[0]?.jobTitle, "Product Manager");
    assert.equal(postings[1]?.jobTitle, "CEO Office");
    assert.ok(postings.every((p) => p.jdText.length > 0));
    assert.equal(ainterviewsAdapter.fetchJd, undefined);
  } finally {
    restoreFetch();
  }
});

test("ainterviewsAdapter.listPostings returns an empty array for an empty board", async () => {
  stubFetch(async () => Response.json({ jobs: [], filters: {} }));
  try {
    const postings = await ainterviewsAdapter.listPostings(company);
    assert.deepEqual(postings, []);
  } finally {
    restoreFetch();
  }
});

test("ainterviewsAdapter.listPostings throws an actionable error on a malformed response", async () => {
  stubFetch(async () => Response.json({ nope: true }));
  try {
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    await assert.rejects(ainterviewsAdapter.listPostings(company), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ainterviews list response failed schema for lenskart_ho/);
      return true;
    });
  } finally {
    restoreFetch();
  }
});
