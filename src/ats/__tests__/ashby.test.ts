import { test } from "node:test";
import assert from "node:assert/strict";
import { ashbyAdapter } from "../ashby.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, fetchSequence, jsonResponse, mkAdapterCompany, at } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "ashby",
  slug: "acme",
  name: "Acme",
  careersUrl: "https://jobs.ashbyhq.com/acme",
});

test("listPostings happy-path normalize maps id/title/location/jobUrl/isRemote/jdText/postedAt", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          {
            id: "job-1",
            title: "Frontend Engineer",
            location: "Pune",
            isRemote: false,
            descriptionPlain: "Own the UI.",
            publishedAt: "2026-06-01T00:00:00.000Z",
            jobUrl: "https://jobs.ashbyhq.com/acme/job-1",
          },
        ],
      }),
    ),
  );
  const postings = await ashbyAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  const posting = at(postings, 0);
  assert.equal(posting.externalId, "job-1");
  assert.equal(posting.jobTitle, "Frontend Engineer");
  assert.equal(posting.location, "Pune");
  assert.equal(posting.jobUrl, "https://jobs.ashbyhq.com/acme/job-1");
  assert.equal(posting.isRemote, false);
  assert.equal(posting.jdText, "Own the UI.");
  assert.equal(posting.postedAt, "2026-06-01T00:00:00.000Z");
});

test("secondaryLocations join onto the primary location with '; ', multiple secondaries joined with ', '", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          {
            id: "job-2",
            title: "Support Engineer",
            location: "Pune",
            secondaryLocations: [{ location: "Chennai" }, { location: "Mumbai" }],
          },
        ],
      }),
    ),
  );
  const postings = await ashbyAdapter.listPostings(company);
  assert.equal(postings[0]?.location, "Pune; Chennai, Mumbai");
});

test("a job with isListed:false is still returned -- the adapter has no isListed filtering", async (t) => {
  stubFetch(
    t,
    fetchSequence(() => jsonResponse({ jobs: [{ id: "job-3", title: "Unlisted Role", isListed: false }] })),
  );
  const postings = await ashbyAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.externalId, "job-3");
});
