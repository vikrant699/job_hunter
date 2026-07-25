// src/ats/sensehq.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSenseHqNextData,
  senseHqInitialJobsData,
  senseHqPaginatedJobsData,
  senseHqPageUrl,
  normalizeSenseHq,
  SenseHqRowSchema,
  sensehqAdapter,
} from "./sensehq.js";
import type { SenseHqRow } from "./sensehq.js";
import type { AdapterCompany } from "../types.js";
import { stubFetch } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "sensehq",
  slug: "tiger-analytics",
  name: "Tiger Analytics",
  careersUrl: "https://tiger-analytics.sensehq.com/careers",
  tenantUrl: "https://tiger-analytics.sensehq.com",
  apiMeta: null,
};

const row: SenseHqRow = {
  id: 56903,
  title: "Platform Engineer",
  location: "Chennai, Bangalore, Hyderabad",
  description_external: "<div>Designation : Platform Engineer</div><div><b>Key Responsibilities:</b></div>",
  workplace_type: null,
  job_status: "OPEN",
  created_on: 1783530472789,
  code: "DEV03891",
};

// Trimmed real initial-page __NEXT_DATA__ island (props.buildId + jobsData).
function initialHtml(rows: unknown[], count: number, buildId = "jEPRsaxO17zCozEuBEAkW"): string {
  const data = {
    props: { pageProps: { jobsData: { rows, count } } },
    page: "/",
    buildId,
  };
  return `<html><head></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

test("extractSenseHqNextData parses the __NEXT_DATA__ island", () => {
  const html = initialHtml([row], 113);
  const parsed = extractSenseHqNextData(html);
  assert.ok(parsed);
});

test("extractSenseHqNextData returns null when the island is absent", () => {
  assert.equal(extractSenseHqNextData("<html>no island here</html>"), null);
});

test("extractSenseHqNextData returns null on malformed JSON in the island", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{not valid json</script>`;
  assert.equal(extractSenseHqNextData(html), null);
});

test("senseHqInitialJobsData reads buildId + rows + count from the initial page", () => {
  const html = initialHtml([row], 113);
  const nextData = extractSenseHqNextData(html);
  const initial = senseHqInitialJobsData(nextData);
  assert.ok(initial);
  assert.equal(initial?.buildId, "jEPRsaxO17zCozEuBEAkW");
  assert.equal(initial?.count, 113);
  assert.equal(initial?.rows.length, 1);
  assert.equal(initial?.rows[0]?.title, "Platform Engineer");
});

test("senseHqInitialJobsData returns null on a shape mismatch (no buildId / no jobsData)", () => {
  assert.equal(senseHqInitialJobsData({ props: { pageProps: {} } }), null);
  assert.equal(senseHqInitialJobsData({ foo: "bar" }), null);
  assert.equal(senseHqInitialJobsData(null), null);
});

test("senseHqPaginatedJobsData reads rows + count from a _next/data page (no buildId in this shape)", () => {
  const page = { pageProps: { jobsData: { rows: [row], count: 113 } }, __N_SSP: true };
  const parsed = senseHqPaginatedJobsData(page);
  assert.ok(parsed);
  assert.equal(parsed?.count, 113);
  assert.equal(parsed?.rows.length, 1);
});

test("senseHqPaginatedJobsData returns null on empty/malformed page json", () => {
  assert.equal(senseHqPaginatedJobsData({}), null);
  assert.equal(senseHqPaginatedJobsData(null), null);
  assert.equal(senseHqPaginatedJobsData("garbage"), null);
});

test("senseHqPaginatedJobsData tolerates a genuinely empty rows page (end of pagination)", () => {
  const page = { pageProps: { jobsData: { rows: [], count: 113 } } };
  const parsed = senseHqPaginatedJobsData(page);
  assert.ok(parsed);
  assert.equal(parsed?.rows.length, 0);
});

test("senseHqPageUrl builds the _next/data pagination URL with all query params, 0-indexed page", () => {
  const url = senseHqPageUrl("https://tiger-analytics.sensehq.com", "jEPRsaxO17zCozEuBEAkW", 0, 50);
  assert.equal(
    url,
    "https://tiger-analytics.sensehq.com/careers/_next/data/jEPRsaxO17zCozEuBEAkW/jobs.json" +
      "?page=0&pageSize=50&department=&location=&title=&sortBy=&orderBy=ASC&minExp=0&maxExp=100&jobType=&workplaceType=",
  );
});

test("SenseHqRowSchema accepts the real row shape and tolerates missing optionals", () => {
  assert.ok(SenseHqRowSchema.safeParse(row).success);
  assert.ok(SenseHqRowSchema.safeParse({ id: 1, title: "x" }).success);
  assert.equal(SenseHqRowSchema.safeParse({ title: "no id" }).success, false);
  assert.equal(SenseHqRowSchema.safeParse({ id: 1 }).success, false);
});

test("normalizeSenseHq maps fields: id-based job URL, inline JD stripped of HTML, ISO date", () => {
  const p = normalizeSenseHq(company, "https://tiger-analytics.sensehq.com", row);
  assert.equal(p.provider, "sensehq");
  assert.equal(p.externalId, "56903");
  assert.equal(p.jobTitle, "Platform Engineer");
  assert.equal(p.jobUrl, "https://tiger-analytics.sensehq.com/careers/jobs/56903");
  assert.equal(p.location, "Chennai, Bangalore, Hyderabad");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Key Responsibilities/);
  assert.doesNotMatch(p.jdText, /<div>|<b>/);
  assert.equal(p.postedAt, new Date(1783530472789).toISOString());
});

test("normalizeSenseHq: workplace_type REMOTE marks isRemote, missing created_on maps to null postedAt", () => {
  const p = normalizeSenseHq(company, "https://tiger-analytics.sensehq.com", {
    ...row,
    workplace_type: "REMOTE",
    created_on: null,
  });
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, null);
});

test("normalizeSenseHq: no location and no JD map to null/empty, not throw", () => {
  const p = normalizeSenseHq(company, "https://tiger-analytics.sensehq.com", {
    ...row,
    location: null,
    description_external: null,
  });
  assert.equal(p.location, null);
  assert.equal(p.jdText, "");
  assert.equal(p.isRemote, false);
});

// --- listPostings (full flow, mocked fetch) -------------------------------

function rowN(id: number): SenseHqRow {
  return { ...row, id, title: `Job ${id}` };
}

test("listPostings: small board — the initial page already has every row, no _next/data fetch", async (t) => {
  let calls = 0;
  stubFetch(t, async (input) => {
    calls++;
    const url = String(input);
    assert.match(url, /\/careers$/, "small board should only ever fetch the SSR careers page");
    return new Response(initialHtml([row], 1), { status: 200 });
  });
  const postings = await sensehqAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.externalId, "56903");
  assert.equal(calls, 1);
});

test("listPostings: empty board returns [] from the shortcut branch", async (t) => {
  stubFetch(t, async () => new Response(initialHtml([], 0), { status: 200 }));
  const postings = await sensehqAdapter.listPostings(company);
  assert.deepEqual(postings, []);
});

test("listPostings: paginates via _next/data, stopping on a short page", async (t) => {
  stubFetch(t, async (input) => {
    const url = String(input);
    if (url.endsWith("/careers")) {
      // Initial page only has 10 of the 113; must paginate via _next/data.
      return new Response(initialHtml(Array.from({ length: 10 }, (_, i) => rowN(1000 + i)), 113), { status: 200 });
    }
    assert.match(url, /_next\/data\/jEPRsaxO17zCozEuBEAkW\/jobs\.json/);
    const m = url.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : -1;
    if (page === 0) {
      const rows = Array.from({ length: 50 }, (_, i) => rowN(2000 + i));
      return Response.json({ pageProps: { jobsData: { rows, count: 63 } } });
    }
    if (page === 1) {
      const rows = Array.from({ length: 13 }, (_, i) => rowN(3000 + i));
      return Response.json({ pageProps: { jobsData: { rows, count: 63 } } });
    }
    throw new Error(`unexpected page ${page}`);
  });
  const postings = await sensehqAdapter.listPostings(company);
  assert.equal(postings.length, 63);
  assert.equal(postings[0]?.externalId, "2000");
  assert.equal(postings.at(-1)?.externalId, "3012");
});

test("listPostings: stops on a zero-row page even when the prior page was full-sized and count is stale", async (t) => {
  // count (999) deliberately doesn't match reality — the spec warns SenseHQ's
  // count can be stale, so termination must not rely on it.
  stubFetch(t, async (input) => {
    const url = String(input);
    if (url.endsWith("/careers")) {
      return new Response(initialHtml(Array.from({ length: 10 }, (_, i) => rowN(1000 + i)), 999), { status: 200 });
    }
    const m = url.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : -1;
    if (page === 0) {
      const rows = Array.from({ length: 50 }, (_, i) => rowN(2000 + i));
      return Response.json({ pageProps: { jobsData: { rows, count: 999 } } });
    }
    return Response.json({ pageProps: { jobsData: { rows: [], count: 999 } } });
  });
  const postings = await sensehqAdapter.listPostings(company);
  assert.equal(postings.length, 50);
});

test("listPostings: throws a clear error when the careers page has no __NEXT_DATA__ island", async (t) => {
  stubFetch(t, async () => new Response("<html>no island</html>", { status: 200 }));
  await assert.rejects(sensehqAdapter.listPostings(company), /sensehq/);
});

test("listPostings: throws a clear error when __NEXT_DATA__ is present but has an unexpected shape", async (t) => {
  stubFetch(
    t,
    async () =>
      new Response(
        `<script id="__NEXT_DATA__" type="application/json">{"buildId":"x","props":{"pageProps":{}}}</script>`,
        { status: 200 },
      ),
  );
  await assert.rejects(sensehqAdapter.listPostings(company), /sensehq/);
});
