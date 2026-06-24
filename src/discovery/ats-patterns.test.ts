import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAtsCandidates } from "./ats-patterns.js";

test("detects a greytHR board URL and registers it as a promotable provider", () => {
  const html = `<a href="https://firstclub.greythr.com/hire/jobs/">Careers</a>`;
  const cands = extractAtsCandidates(html, "https://firstclub.com/careers");
  const g = cands.find((c) => c.provider === "greythr");
  assert.ok(g, "greythr candidate should be detected");
  assert.equal(g!.slug, "firstclub");
  assert.equal(g!.url, "https://firstclub.greythr.com/hire/jobs/");
  assert.equal(g!.hasAdapter, true);
  assert.equal(g!.canValidate, true);
});

test("ignores the greytHR vendor site (www.greythr.com)", () => {
  const cands = extractAtsCandidates(`<a href="https://www.greythr.com/careers/">x</a>`, "https://x.com");
  assert.equal(cands.some((c) => c.provider === "greythr"), false);
});

test("detects greytHR from the careersUrl itself (redirect target)", () => {
  const cands = extractAtsCandidates("", "https://acme.greythr.com/hire/jobs/");
  const g = cands.find((c) => c.provider === "greythr");
  assert.equal(g?.slug, "acme");
});
