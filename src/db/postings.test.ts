import { test } from "node:test";
import assert from "node:assert/strict";
import { insertPostingIfNew, postingExists } from "./postings.js";
import type { NormalizedPosting } from "../types.js";

function mk(externalId: string): NormalizedPosting {
  return {
    provider: "custom", externalId, companySlug: "acme", companyName: "Acme",
    jobTitle: "Data Analyst", jobUrl: "https://x/y", location: "Bengaluru",
    isRemote: false, jdText: "sql dashboards", postedAt: null,
  };
}

test("postingExists is per-profile: a job checked by alice is still new for bob", () => {
  const id = `iso-${Date.now()}`;
  assert.equal(insertPostingIfNew(mk(id), "alice"), true);
  assert.equal(postingExists("custom", id, "alice"), true);
  assert.equal(postingExists("custom", id, "bob"), false);
  assert.equal(insertPostingIfNew(mk(id), "bob"), true);
  assert.equal(postingExists("custom", id, "bob"), true);
});
