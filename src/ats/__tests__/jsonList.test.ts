// src/ats/jsonList.test.ts — exercises makeJsonListAdapter against a fake
// vendor (not a real ATS) so the factory's own contract is pinned
// independently of any one real adapter's schema/normalize quirks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { makeJsonListAdapter } from "../jsonList.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";
import { stubFetch, fetchSequence, jsonResponse, mkAdapterCompany } from "./testHelpers.js";

// "greenhouse" is reused here purely as a valid Provider literal — the
// factory has no per-provider special-casing, so any real enum member is a
// fine stand-in for a fake vendor in this test.
const FAKE_PROVIDER = "greenhouse";
const LIST_URL = "https://fake.example.com/api/jobs";

const FakeItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  active: z.boolean().nullable().optional(),
});
type FakeItem = z.infer<typeof FakeItemSchema>;
const FakeResponseSchema = z.object({ jobs: z.array(FakeItemSchema) });
type FakeResponse = z.infer<typeof FakeResponseSchema>;

const company: AdapterCompany = mkAdapterCompany({
  provider: FAKE_PROVIDER,
  slug: "fakeco",
  name: "FakeCo",
  careersUrl: "https://fake.example.com/careers",
});

function normalizeFake(c: AdapterCompany, item: FakeItem): NormalizedPosting {
  return {
    provider: FAKE_PROVIDER,
    externalId: item.id,
    companySlug: c.slug,
    companyName: c.name,
    jobTitle: item.title,
    jobUrl: `https://fake.example.com/jobs/${item.id}`,
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
}

test("makeJsonListAdapter: happy path maps every item via the vendor's normalize", async (t) => {
  const adapter = makeJsonListAdapter<FakeResponse, FakeItem>({
    provider: FAKE_PROVIDER,
    url: () => LIST_URL,
    schema: FakeResponseSchema,
    items: (parsed) => parsed.jobs,
    normalize: normalizeFake,
  });
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          { id: "1", title: "Engineer" },
          { id: "2", title: "Designer" },
        ],
      }),
    ),
  );
  const postings = await adapter.listPostings(company);
  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.jobTitle, "Engineer");
  assert.equal(postings[0].externalId, "1");
  assert.equal(postings[1]?.jobTitle, "Designer");
});

test("makeJsonListAdapter: keep filters items out before normalize runs", async (t) => {
  const adapter = makeJsonListAdapter<FakeResponse, FakeItem>({
    provider: FAKE_PROVIDER,
    url: () => LIST_URL,
    schema: FakeResponseSchema,
    items: (parsed) => parsed.jobs,
    keep: (item) => item.active !== false,
    normalize: normalizeFake,
  });
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          { id: "1", title: "Live", active: true },
          { id: "2", title: "Dead", active: false },
        ],
      }),
    ),
  );
  const postings = await adapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.jobTitle, "Live");
});

test("makeJsonListAdapter: normalize returning null skips that item", async (t) => {
  const adapter = makeJsonListAdapter<FakeResponse, FakeItem>({
    provider: FAKE_PROVIDER,
    url: () => LIST_URL,
    schema: FakeResponseSchema,
    items: (parsed) => parsed.jobs,
    normalize: (c, item) => (item.title === "Skip me" ? null : normalizeFake(c, item)),
  });
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          { id: "1", title: "Skip me" },
          { id: "2", title: "Keep me" },
        ],
      }),
    ),
  );
  const postings = await adapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.jobTitle, "Keep me");
});

test("makeJsonListAdapter: duplicate externalId is deduped, first occurrence wins", async (t) => {
  const adapter = makeJsonListAdapter<FakeResponse, FakeItem>({
    provider: FAKE_PROVIDER,
    url: () => LIST_URL,
    schema: FakeResponseSchema,
    items: (parsed) => parsed.jobs,
    normalize: normalizeFake,
  });
  stubFetch(
    t,
    fetchSequence(() =>
      jsonResponse({
        jobs: [
          { id: "1", title: "First" },
          { id: "1", title: "Duplicate" },
        ],
      }),
    ),
  );
  const postings = await adapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.jobTitle, "First");
});

test("makeJsonListAdapter: a response failing the schema rejects", async (t) => {
  const adapter = makeJsonListAdapter<FakeResponse, FakeItem>({
    provider: FAKE_PROVIDER,
    url: () => LIST_URL,
    schema: FakeResponseSchema,
    items: (parsed) => parsed.jobs,
    normalize: normalizeFake,
  });
  stubFetch(t, fetchSequence(() => jsonResponse({ notJobs: [] })));
  await assert.rejects(adapter.listPostings(company), /greenhouse list response failed schema/);
});
