import { test } from "node:test";
import assert from "node:assert/strict";
import { countDistinctOrgs, aggregatorWarning } from "../aggregatorGuard.js";
import type { NormalizedPosting } from "../../types.js";

function mkPosting(companyName: string): NormalizedPosting {
  return {
    provider: "greenhouse",
    externalId: "1",
    companySlug: "x",
    companyName,
    jobTitle: "X",
    jobUrl: "https://x",
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
}

test("countDistinctOrgs dedupes case-insensitively and trims whitespace", () => {
  assert.equal(countDistinctOrgs([mkPosting("Acme"), mkPosting("acme"), mkPosting("  ACME  ")]), 1);
});

test("countDistinctOrgs ignores empty/whitespace-only names", () => {
  assert.equal(countDistinctOrgs([mkPosting(""), mkPosting("   "), mkPosting("Acme")]), 1);
});

test("countDistinctOrgs counts each distinct org once", () => {
  assert.equal(countDistinctOrgs([mkPosting("A"), mkPosting("B"), mkPosting("C")]), 3);
});

test("countDistinctOrgs is 0 for an empty listing", () => {
  assert.equal(countDistinctOrgs([]), 0);
});

test("aggregatorWarning is null at or below the threshold of 10 distinct orgs", () => {
  const postings = Array.from({ length: 10 }, (_, i) => mkPosting(`Org ${i}`));
  assert.equal(aggregatorWarning("greenhouse", "some-board", postings), null);
});

test("aggregatorWarning fires above 10 distinct orgs, with the provider/slug/count and first 3 distinct names", () => {
  const postings = Array.from({ length: 12 }, (_, i) => mkPosting(`Org ${i}`));
  const warning = aggregatorWarning("greenhouse", "some-board", postings);
  assert.deepEqual(warning, {
    provider: "greenhouse",
    slug: "some-board",
    distinctOrgs: 12,
    sample: ["Org 0", "Org 1", "Org 2"],
  });
});

test("aggregatorWarning's sample lists distinct names in first-seen order, case-insensitively deduped", () => {
  const postings = [
    mkPosting("Org 0"),
    mkPosting("org 0"),
    ...Array.from({ length: 11 }, (_, i) => mkPosting(`Org ${i + 1}`)),
  ];
  const warning = aggregatorWarning("greenhouse", "some-board", postings);
  assert.ok(warning);
  assert.deepEqual(warning.sample, ["Org 0", "Org 1", "Org 2"]);
});
