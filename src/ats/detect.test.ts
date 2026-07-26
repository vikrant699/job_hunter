import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAtsCandidates } from "./detect.js";

test("detects a greytHR board URL and registers it as a promotable provider", () => {
  const html = `<a href="https://firstclub.greythr.com/hire/jobs/">Careers</a>`;
  const cands = extractAtsCandidates(html, "https://firstclub.com/careers");
  const g = cands.find((c) => c.provider === "greythr");
  assert.ok(g, "greythr candidate should be detected");
  assert.equal(g.slug, "firstclub");
  assert.equal(g.url, "https://firstclub.greythr.com/hire/jobs/");
  assert.equal(g.hasAdapter, true);
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

test("detects a Zoho Recruit board and preserves the tenant's page name", () => {
  const html = `<a href="https://spendflo.zohorecruit.com/jobs/Job-openings">Careers</a>`;
  const cands = extractAtsCandidates(html, "https://spendflo.com/careers");
  const z = cands.find((c) => c.provider === "zohorecruit");
  assert.ok(z, "zohorecruit candidate should be detected");
  assert.equal(z.slug, "spendflo");
  assert.equal(z.url, "https://spendflo.zohorecruit.com/jobs/Job-openings");
  assert.equal(z.hasAdapter, true);
});

test("Zoho Recruit .in hosts and job-detail deep links canonicalize to the board", () => {
  const html = `<a href="https://acowale.zohorecruit.in/jobs/Careers/196319000004222912/Frontend-Developer">FE</a>`;
  const z = extractAtsCandidates(html, "https://x.com").find((c) => c.provider === "zohorecruit");
  assert.equal(z?.slug, "acowale");
  assert.equal(z.url, "https://acowale.zohorecruit.in/jobs/Careers");
});

test("Zoho Recruit bare-host mentions default to /jobs/Careers; vendor www is ignored", () => {
  const z = extractAtsCandidates(`<a href="https://acme.zohorecruit.com">jobs</a>`, "https://x.com")
    .find((c) => c.provider === "zohorecruit");
  assert.equal(z?.url, "https://acme.zohorecruit.com/jobs/Careers");
  const none = extractAtsCandidates(`<a href="https://www.zohorecruit.com/pricing">x</a>`, "https://x.com");
  assert.equal(none.some((c) => c.provider === "zohorecruit"), false);
});

test("hasAdapter is true exactly when the provider is in ProviderSchema", () => {
  const gh = extractAtsCandidates(`<a href="https://boards.greenhouse.io/acme">jobs</a>`, "https://acme.com/careers");
  assert.equal(gh[0]?.hasAdapter, true);
  const icims = extractAtsCandidates(`<a href="https://careers-foo.icims.com/jobs">jobs</a>`, "https://foo.com/careers");
  assert.equal(icims[0]?.provider, "icims");
  assert.equal(icims[0].hasAdapter, false);
});
