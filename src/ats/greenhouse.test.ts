// src/ats/greenhouse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { greenhouseAdapter } from "./greenhouse.js";
import type { AdapterCompany } from "../types.js";
import { stubFetch, fetchSequence, jsonResponse, mkAdapterCompany } from "./test-helpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "greenhouse",
  slug: "acme",
  name: "Acme",
  careersUrl: "https://boards.greenhouse.io/acme",
});

test("listPostings maps id/title/location/absolute_url/updated_at", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          {
            id: 12345,
            title: "Backend Engineer",
            updated_at: "2026-07-01T10:00:00Z",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/12345",
            location: { name: "Bengaluru, India" },
            content: "<p>Build things.</p>",
          },
        ],
      }),
    ),
  );
  const postings = await greenhouseAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.externalId, "12345");
  assert.equal(postings[0]?.jobTitle, "Backend Engineer");
  assert.equal(postings[0]?.location, "Bengaluru, India");
  assert.equal(postings[0]?.jobUrl, "https://boards.greenhouse.io/acme/jobs/12345");
  assert.equal(postings[0]?.postedAt, "2026-07-01T10:00:00Z");
  assert.equal(postings[0]?.isRemote, false);
  assert.equal(postings[0]?.jdText, "Build things.");
});

test("apiMeta.boardSlug overrides the registry slug in the requested URL", async (t) => {
  let requestedUrl = "";
  stubFetch(t, async (input) => {
    requestedUrl = String(input);
    return jsonResponse({ jobs: [] });
  });
  const c = mkAdapterCompany(
    {
      provider: "greenhouse",
      slug: "razorpayx-payroll",
      name: "RazorpayX Payroll",
      careersUrl: "https://boards.greenhouse.io/razorpayx-payroll",
    },
    { apiMeta: { boardSlug: "razorpaysoftwareprivatelimited" } },
  );
  await greenhouseAdapter.listPostings(c);
  assert.equal(requestedUrl, "https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs?content=true");
});

test("a response failing the jobs-array schema rejects", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ notJobs: [] })));
  await assert.rejects(greenhouseAdapter.listPostings(company), /greenhouse response failed schema/);
});
