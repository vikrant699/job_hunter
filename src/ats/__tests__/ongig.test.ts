// src/ats/ongig.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ongigAdapter } from "../ongig.js";
import type { OngigResult } from "../ongig.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, fetchSequence, jsonResponse, mkAdapterCompany } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany(
  { provider: "ongig", slug: "yum", name: "Yum! Brands", careersUrl: "https://jobs.yum.com/" },
  { apiMeta: { groupId: "1583" } },
);

function sessionResponse(cookies: string[]): Response {
  return new Response(null, { status: 200, headers: cookies.map((c) => ["Set-Cookie", c]) });
}

function ongigResult(overrides: Partial<OngigResult> = {}): OngigResult {
  return {
    title: { raw: "Software Engineer" },
    location: { raw: "Gurgaon, India" },
    req_id: { raw: "REQ1" },
    url: { raw: "/job/software-engineer-req1" },
    country_filter: { raw: "india" },
    content: { raw: "Full JD text." },
    ...overrides,
  };
}

// Uses the global Response.json (not jsonResponse) because 'results' here is already OngigResult[]-typed, not a fresh literal.
function pageResponse(results: OngigResult[], totalPages: number | null): Response {
  return Response.json({
    meta: { page: { current: 1, total_pages: totalPages, total_results: results.length } },
    results,
  });
}

test("session handshake: XSRF-TOKEN + session cookie from the GET fold into the POST's x-xsrf-token + Cookie headers", async (t) => {
  const postInits: RequestInit[] = [];
  stubFetch(t, async (input, init) => {
    if (init?.method === "POST") {
      postInits.push(init);
      return pageResponse([ongigResult()], 1);
    }
    assert.equal(String(input), "https://jobs.yum.com/");
    return sessionResponse(["XSRF-TOKEN=abc%3D; Path=/", "laravel_session=xyz123; Path=/; HttpOnly"]);
  });
  await ongigAdapter.listPostings(company);
  assert.equal(postInits.length, 1);
  const headers = new Headers(postInits[0]?.headers);
  assert.equal(headers.get("x-xsrf-token"), "abc=");
  assert.equal(headers.get("cookie"), "XSRF-TOKEN=abc%3D; laravel_session=xyz123");
});

test("a session response with no XSRF-TOKEN cookie throws the adapter's documented failure", async (t) => {
  stubFetch(t, async (_input, init) => {
    if (init?.method === "POST") throw new Error("should not reach the POST without a token");
    return sessionResponse(["laravel_session=xyz123; Path=/; HttpOnly"]);
  });
  await assert.rejects(ongigAdapter.listPostings(company), /no XSRF-TOKEN cookie/);
});

test("paginates via meta.page.total_pages, accumulates across pages, and dedupes an id repeated across pages", async (t) => {
  let postCalls = 0;
  stubFetch(t, async (_input, init) => {
    if (init?.method !== "POST") return sessionResponse(["XSRF-TOKEN=abc%3D; Path=/", "s=1"]);
    postCalls += 1;
    if (postCalls === 1) {
      return pageResponse(
        [ongigResult({ req_id: { raw: "REQ1" } }), ongigResult({ req_id: { raw: "REQ2" }, title: { raw: "Job Two" } })],
        2,
      );
    }
    return pageResponse(
      [
        ongigResult({ req_id: { raw: "REQ2" }, title: { raw: "Job Two" } }),
        ongigResult({ req_id: { raw: "REQ3" }, title: { raw: "Job Three" } }),
      ],
      2,
    );
  });
  const postings = await ongigAdapter.listPostings(company);
  assert.deepEqual(postings.map((p) => p.externalId), ["REQ1", "REQ2", "REQ3"]);
  assert.equal(postCalls, 2, "must stop after total_pages -- no third page fetched");
});

test("an empty results page ends the loop even though total_pages says more remain", async (t) => {
  let postCalls = 0;
  stubFetch(t, async (_input, init) => {
    if (init?.method !== "POST") return sessionResponse(["XSRF-TOKEN=abc%3D; Path=/", "s=1"]);
    postCalls += 1;
    return pageResponse([], 2);
  });
  const postings = await ongigAdapter.listPostings(company);
  assert.deepEqual(postings, []);
  assert.equal(postCalls, 1, "must not fetch a second page once a page returns zero results");
});

test("a response failing the meta/results schema rejects", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      () => sessionResponse(["XSRF-TOKEN=abc%3D; Path=/", "s=1"]),
      () => jsonResponse({ notMeta: true }),
    ),
  );
  await assert.rejects(ongigAdapter.listPostings(company), /ongig list p1 response failed schema/);
});
