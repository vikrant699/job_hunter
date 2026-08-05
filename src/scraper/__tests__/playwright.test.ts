import { test } from "node:test";
import assert from "node:assert/strict";
import { LOAD_MORE_TEXT_RE } from "../playwright.js";

test("LOAD_MORE_TEXT_RE matches load-more CTAs and not nav/marketing links", () => {
  for (const yes of ["Load more", "Show More", "View more jobs", "See more openings", "load more results", "More jobs"]) {
    assert.equal(LOAD_MORE_TEXT_RE.test(yes), true, `should match: ${yes}`);
  }
  for (const no of ["Learn more", "Read more about us", "More about Acme", "Next", "Apply now"]) {
    assert.equal(LOAD_MORE_TEXT_RE.test(no), false, `should NOT match: ${no}`);
  }
});
