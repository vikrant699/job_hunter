import { test } from "node:test";
import assert from "node:assert/strict";
import { srPostingUrl } from "../smartrecruiters.js";

test("prefers the API postingUrl", () => {
  assert.equal(
    srPostingUrl("BoschGroup", "744000127163316", {
      postingUrl: "https://jobs.smartrecruiters.com/BoschGroup/744000127163316-analytics-engineer",
      applyUrl: "https://jobs.smartrecruiters.com/BoschGroup/744000127163316-analytics-engineer?oga=true",
    }),
    "https://jobs.smartrecruiters.com/BoschGroup/744000127163316-analytics-engineer",
  );
});

test("falls back to applyUrl when postingUrl is absent", () => {
  assert.equal(
    srPostingUrl("BoschGroup", "1", { applyUrl: "https://jobs.smartrecruiters.com/BoschGroup/1-x?oga=true" }),
    "https://jobs.smartrecruiters.com/BoschGroup/1-x?oga=true",
  );
});

test("synthesizes a jobs.smartrecruiters.com URL when detail has neither (never the broken careers. host)", () => {
  const u = srPostingUrl("BoschGroup", "744000127163316");
  assert.equal(u, "https://jobs.smartrecruiters.com/BoschGroup/744000127163316");
  assert.ok(!u.includes("careers.smartrecruiters.com"));
});

test("synthesized fallback url-encodes slug and id", () => {
  assert.equal(srPostingUrl("Acme Co", "a/b"), "https://jobs.smartrecruiters.com/Acme%20Co/a%2Fb");
});

test("ignores a non-absolute API url and synthesizes instead", () => {
  assert.equal(
    srPostingUrl("BoschGroup", "1", { postingUrl: "/relative/path" }),
    "https://jobs.smartrecruiters.com/BoschGroup/1",
  );
});
