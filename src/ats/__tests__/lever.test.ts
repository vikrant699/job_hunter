// src/ats/lever.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { leverAdapter } from "../lever.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, fetchSequence, jsonResponse, mkAdapterCompany } from "./test-helpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "lever",
  slug: "acme",
  name: "Acme",
  careersUrl: "https://jobs.lever.co/acme",
});

test("listPostings assembles jdText from descriptionPlain + lists[] + additionalPlain (all three segments present)", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse([
        {
          id: "1",
          text: "Software Engineer",
          hostedUrl: "https://jobs.lever.co/acme/1",
          descriptionPlain: "Intro.",
          lists: [{ text: "Requirements", content: "<ul><li>TS</li></ul>" }],
          additionalPlain: "Perks.",
        },
      ]),
    ),
  );
  const postings = await leverAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  // Pinned real output (htmlToText("<ul><li>TS</li></ul>") -> "TS"); the
  // invariant that matters is all three segments (Requirements/TS/Perks.) present.
  assert.equal(postings[0]?.jdText, "Intro.\n\nRequirements\nTS\n\nPerks.");
});

test("a malformed item in the response array is skipped while a valid one survives", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse([
        { id: "1", text: "Valid Job", hostedUrl: "https://jobs.lever.co/acme/1" },
        { junk: true },
      ]),
    ),
  );
  const postings = await leverAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.externalId, "1");
});

test("workplaceType 'remote' sets isRemote true", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse([{ id: "1", text: "Job", hostedUrl: "https://jobs.lever.co/acme/1", workplaceType: "remote" }]),
    ),
  );
  const postings = await leverAdapter.listPostings(company);
  assert.equal(postings[0]?.isRemote, true);
});

test("categories.location matching REMOTE_RE sets isRemote true", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse([
        {
          id: "1",
          text: "Job",
          hostedUrl: "https://jobs.lever.co/acme/1",
          categories: { location: "Remote - India" },
        },
      ]),
    ),
  );
  const postings = await leverAdapter.listPostings(company);
  assert.equal(postings[0]?.location, "Remote - India");
  assert.equal(postings[0].isRemote, true);
});

test("epoch-ms createdAt maps to the ISO postedAt", async (t) => {
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse([{ id: "1", text: "Job", hostedUrl: "https://jobs.lever.co/acme/1", createdAt: 1719800000000 }]),
    ),
  );
  const postings = await leverAdapter.listPostings(company);
  assert.equal(postings[0]?.postedAt, new Date(1719800000000).toISOString());
});

test("a non-array response rejects", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ error: "not found" })));
  await assert.rejects(leverAdapter.listPostings(company), /was not an array/);
});
