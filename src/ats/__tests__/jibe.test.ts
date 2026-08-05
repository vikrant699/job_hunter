// src/ats/jibe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { jibeApiUrl, jibePageJobs, normalizeJibe, jibeAdapter } from "../jibe.js";
import type { JibeJob } from "../jibe.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "jibe", slug: "schneider-pw", name: "Schneider Electric India",
  careersUrl: "https://careers.se.com/jobs", tenantUrl: "https://careers.se.com",
  apiMeta: { location: "India" },
};

const job: JibeJob = {
  slug: "117559",
  req_id: "117559",
  title: "Senior Software Engineer I - React Native",
  description: "<p>Build mobile experiences.</p><ul><li>React Native</li></ul>",
  full_location: "Bangalore, India",
  short_location: "Bangalore, India",
  location_name: "Bangalore",
  country: "India",
  location_type: "onsite",
  posted_date: "July 1, 2026",
  meta_data: { canonical_url: "https://careers.se.com/jobs/117559?lang=en-us" },
};

test("jibeApiUrl builds the paged search URL from the tenant origin with the apiMeta location filter", () => {
  assert.equal(jibeApiUrl(company, 3), "https://careers.se.com/api/jobs?page=3&location=India");
});

test("jibeApiUrl falls back to the careers URL origin and omits the filter without apiMeta.location", () => {
  const c: AdapterCompany = { ...company, tenantUrl: null, apiMeta: null };
  assert.equal(jibeApiUrl(c, 1), "https://careers.se.com/api/jobs?page=1");
});

test("jibePageJobs unwraps the jobs[].data envelope and totalCount", () => {
  const page = { jobs: [{ data: job }], totalCount: 497, count: 10 };
  const r = jibePageJobs(page);
  assert.equal(r.totalCount, 497);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0]?.title, "Senior Software Engineer I - React Native");
});

test("normalizeJibe maps fields: canonical URL, location precedence, html-stripped JD, ISO date", () => {
  const p = normalizeJibe(company, job);
  assert.equal(p.provider, "jibe");
  assert.equal(p.externalId, "117559");
  assert.equal(p.jobTitle, "Senior Software Engineer I - React Native");
  assert.equal(p.jobUrl, "https://careers.se.com/jobs/117559?lang=en-us");
  assert.equal(p.location, "Bangalore, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /React Native/);
  assert.doesNotMatch(p.jdText, /<p>|<li>/);
  assert.equal(p.postedAt, new Date("July 1, 2026").toISOString());
});

test("normalizeJibe synthesizes the job URL from slug when meta_data has no canonical_url", () => {
  const p = normalizeJibe(company, { ...job, meta_data: null });
  assert.equal(p.jobUrl, "https://careers.se.com/jobs/117559");
});

test("normalizeJibe: remote location_type sets isRemote, unparseable date maps to null", () => {
  const p = normalizeJibe(company, { ...job, location_type: "remote", posted_date: "recently" });
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, null);
});

// --- listPostings pagination -------------------------------------------------

/** A minimal job with a unique slug, so cross-page identity is real. */
function jobN(n: number): JibeJob {
  return { slug: String(n), title: `Role ${n}`, full_location: "Bangalore, India" };
}

/** One API page: `count` jobs numbered from `start`, plus the reported total. */
function apiPage(count: number, start: number, totalCount: number | null): string {
  const jobs = Array.from({ length: count }, (_, i) => ({ data: jobN(start + i) }));
  return JSON.stringify({ jobs, totalCount });
}

const realFetch = globalThis.fetch;
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Serve a canned body per `?page=N`; anything past the end is an empty page.
 *  Returns the page numbers requested, in order. */
function stubPages(pages: Record<string, string>, totalCount: number | null): string[] {
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const p = new URL(String(input)).searchParams.get("page") ?? "";
    seen.push(p);
    return new Response(pages[p] ?? apiPage(0, 0, totalCount), { status: 200 });
  };
  return seen;
}

test("jibeAdapter.listPostings collects the whole board when the tenant pages below the assumed 10", async () => {
  // The page-size params are ignored, so 10 was an assumption about the
  // engine. A tenant serving 4 a page had page 1 judged short and stopped
  // there — and totalCount could not save it, because the short-page break
  // happens before the total is ever compared.
  const seen = stubPages({ "1": apiPage(4, 1, 10), "2": apiPage(4, 5, 10), "3": apiPage(2, 9, 10) }, 10);
  try {
    const items = await jibeAdapter.listPostings(company);
    assert.equal(items.length, 10, "the reported total, not just page 1");
    assert.deepEqual(seen, ["1", "2", "3"]);
    assert.deepEqual(items.map((p) => p.externalId), Array.from({ length: 10 }, (_, i) => String(i + 1)));
  } finally {
    restoreFetch();
  }
});

test("jibeAdapter.listPostings is unchanged on a tenant that really does page at 10", async () => {
  const seen = stubPages({ "1": apiPage(10, 1, 23), "2": apiPage(10, 11, 23), "3": apiPage(3, 21, 23) }, 23);
  try {
    const items = await jibeAdapter.listPostings(company);
    assert.equal(items.length, 23);
    assert.deepEqual(seen, ["1", "2", "3"]);
  } finally {
    restoreFetch();
  }
});

test("jibeAdapter.listPostings still ends on a genuinely short final page when totalCount is absent", async () => {
  const seen = stubPages({ "1": apiPage(10, 1, null), "2": apiPage(10, 11, null), "3": apiPage(3, 21, null) }, null);
  try {
    const items = await jibeAdapter.listPostings(company);
    assert.equal(items.length, 23);
    assert.deepEqual(seen, ["1", "2", "3"], "the 3-job page 3 ends it with no total to rely on");
  } finally {
    restoreFetch();
  }
});

test("jibeAdapter.listPostings stops on a board that ignores ?page and re-serves page 1", async () => {
  // With totalCount absent AND every page full, neither the total nor the
  // short-page rule can fire; the exact-page-repeat stall guard is the only
  // terminator short of the runaway cap.
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(new URL(String(input)).searchParams.get("page") ?? "");
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(apiPage(10, 1, null), { status: 200 });
  };
  try {
    const items = await jibeAdapter.listPostings(company);
    assert.equal(items.length, 10, "the repeat contributes nothing new");
    assert.deepEqual(seen, ["1", "2"]);
  } finally {
    restoreFetch();
  }
});
