import { test } from "node:test";
import assert from "node:assert/strict";
import { selectShortlistItems } from "./shortlist.js";
import type { CandidateLink } from "../scraper/cheerio.js";

const cands: CandidateLink[] = [
  { url: "https://x.com/jobs/1", text: "Data Analyst" },
  { url: "https://x.com/jobs/2", text: "Business Analyst" },
  { url: "https://x.com/jobs/3", text: "Product Analyst" },
];

test("one malformed item does not discard the whole batch", () => {
  const raw = [
    { url: "https://x.com/jobs/1", title: "Senior Data Analyst" },
    { url: "not-a-url", title: "Broken" }, // malformed url → dropped
    { title: "No URL at all" }, // missing url → dropped
    { url: "https://x.com/jobs/2", title: "BA" },
  ];
  const out = selectShortlistItems(raw, cands);
  assert.deepEqual(out.map((j) => j.url), ["https://x.com/jobs/1", "https://x.com/jobs/2"]);
});

test("empty title falls back to the cheerio anchor text", () => {
  const raw = [{ url: "https://x.com/jobs/3", title: "   " }];
  const out = selectShortlistItems(raw, cands);
  assert.deepEqual(out, [{ url: "https://x.com/jobs/3", title: "Product Analyst" }]);
});

test("hallucinated URLs (not in the candidate set) are dropped", () => {
  const raw = [{ url: "https://x.com/jobs/999", title: "Ghost Role" }];
  assert.equal(selectShortlistItems(raw, cands).length, 0);
});

test("duplicate URLs are collapsed", () => {
  const raw = [
    { url: "https://x.com/jobs/1", title: "Data Analyst" },
    { url: "https://x.com/jobs/1", title: "Data Analyst (dup)" },
  ];
  assert.equal(selectShortlistItems(raw, cands).length, 1);
});
