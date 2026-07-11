// src/ats/kula.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeKula, kulaListUrl, kulaJobUrl, kulaAdapter } from "./kula.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "kula", slug: "avoma", name: "Avoma",
  careersUrl: "https://careers.kula.ai/avoma", tenantUrl: null, apiMeta: null,
};

// Trimmed live fixture — captured 2026-07-11 from
// https://careers.kula.ai/api/internal/ats_job_posts?accountName=avoma&page=1&type=ats_job_post.index&items=99
const indiaJob = {
  id: 2941,
  account_id: 1278,
  title: "Senior Software Engineer - Frontend",
  listed: true,
  ats_job: {
    job_description: "<h3>Summary</h3><p>Build <strong>React</strong> UI for the Avoma platform.</p>",
    workplace: "office",
    offices: [
      {
        id: 713,
        name: "Pune, Maharashtra, India",
        location: "Pune, Maharashtra, India",
        country: "India",
        state: "Maharashtra",
        city: "Pune",
        remote: false,
        workplace: "office",
      },
    ],
  },
};

const remoteJob = {
  id: 3001,
  title: "Remote Support Engineer",
  listed: true,
  ats_job: {
    job_description: "<p>Support customers.</p>",
    workplace: "remote",
    offices: [],
  },
};

const unlistedJob = {
  id: 9999,
  title: "Draft Role",
  listed: false,
  ats_job: { job_description: "<p>hidden</p>", workplace: "office", offices: [] },
};

test("normalizeKula maps an India office posting", () => {
  const p = normalizeKula(company, indiaJob);
  assert.equal(p.provider, "kula");
  assert.equal(p.externalId, "2941");
  assert.equal(p.jobTitle, "Senior Software Engineer - Frontend");
  assert.equal(p.jobUrl, "https://careers.kula.ai/avoma/2941/");
  assert.equal(p.location, "Pune, Maharashtra, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Build React UI/);
  assert.equal(p.postedAt, null);
});

test("normalizeKula flags remote via ats_job.workplace when offices is empty", () => {
  const p = normalizeKula(company, remoteJob);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, true);
});

test("kulaListUrl / kulaJobUrl build the documented endpoints", () => {
  assert.equal(
    kulaListUrl("cashfree", 2),
    "https://careers.kula.ai/api/internal/ats_job_posts?accountName=cashfree&page=2&type=ats_job_post.index&items=99",
  );
  assert.equal(kulaJobUrl("avoma", 2941), "https://careers.kula.ai/avoma/2941/");
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("kulaAdapter.listPostings filters listed:false and stops on a short page", async () => {
  stubFetch(async () =>
    Response.json({
      data: [indiaJob, remoteJob, unlistedJob],
      meta: { count: 2, page: 1, items: 99, pages: 1 },
    }),
  );
  try {
    const postings = await kulaAdapter.listPostings(company);
    assert.equal(postings.length, 2);
    assert.deepEqual(postings.map((p) => p.externalId).sort(), ["2941", "3001"]);
  } finally {
    restoreFetch();
  }
});

test("kulaAdapter.listPostings pages through meta.pages without truncating", async () => {
  let calls = 0;
  stubFetch(async (input) => {
    calls += 1;
    const url = String(input);
    assert.match(url, /page=\d+/);
    if (url.includes("page=1")) {
      return Response.json({
        data: Array.from({ length: 99 }, (_, i) => ({ ...indiaJob, id: i + 1 })),
        meta: { count: 101, page: 1, items: 99, pages: 2 },
      });
    }
    return Response.json({
      data: [{ ...indiaJob, id: 100 }, { ...indiaJob, id: 101 }],
      meta: { count: 101, page: 2, items: 99, pages: 2 },
    });
  });
  try {
    const postings = await kulaAdapter.listPostings(company);
    assert.equal(postings.length, 101);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});
