// src/ats/eightfold.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEightfold } from "../eightfold.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "eightfold", slug: "astrazeneca", name: "AstraZeneca",
  careersUrl: "https://astrazeneca.eightfold.ai/careers",
  tenantUrl: "https://astrazeneca.eightfold.ai", apiMeta: { domain: "astrazeneca.com" },
};

const position = {
  id: 563877690542312, name: "Analytics Manager - Mumbai",
  location: "Mumbai, , India", locations: ["Mumbai, , India"],
  t_create: 1780531200,
  canonicalPositionUrl: "https://astrazeneca.eightfold.ai/careers/job/563877690542312",
  job_description: "",
};

test("normalizeEightfold maps list metadata (JD fetched separately)", () => {
  const p = normalizeEightfold(company, position);
  assert.equal(p.externalId, "563877690542312");
  assert.equal(p.jobTitle, "Analytics Manager - Mumbai");
  assert.equal(p.location, "Mumbai, , India");
  assert.equal(p.jobUrl, "https://astrazeneca.eightfold.ai/careers/job/563877690542312");
  assert.equal(p.jdText, ""); // empty in list; populated by fetchJd
  assert.equal(p.postedAt, new Date(1780531200 * 1000).toISOString());
});

// HSBC's tenant (portal.careers.hsbc.com) clamps every response to 10 positions
// regardless of the num= we ask for. With a hardcoded pageSize the first page
// read as "short" and pagination stopped at 10 of 1,563 — the adapter must
// infer the page size from what the server actually serves and keep going.
test("listPostings pages through a server that clamps num= below the requested page size", async (t) => {
  const { eightfoldAdapter } = await import("../eightfold.js");
  const { stubFetch, fetchSequence, jsonResponse } = await import("./testHelpers.js");

  const page = (startId: number, n: number, count: number) => () =>
    jsonResponse({
      count,
      positions: Array.from({ length: n }, (_, i) => ({
        id: startId + i,
        name: `Job ${startId + i}`,
        location: "Hyderabad, , India",
        t_create: 1780531200,
        canonicalPositionUrl: null,
        job_description: "",
      })),
    });

  // Server clamps at 10/page; board has 25 jobs -> 3 pages (10, 10, 5).
  stubFetch(t, fetchSequence(page(0, 10, 25), page(10, 10, 25), page(20, 5, 25)));

  const posts = await eightfoldAdapter.listPostings(company);
  assert.equal(posts.length, 25);
  assert.equal(posts[24]?.externalId, "24");
});
