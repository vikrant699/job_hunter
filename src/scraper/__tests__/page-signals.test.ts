import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCareersPage } from "../page-signals.js";

test("a real careers page is recognized by title/heading wording", () => {
  const html = "<html><head><title>Careers at Acme</title></head><body><h1>Open positions</h1></body></html>";
  const s = analyzeCareersPage(html, "https://acme.example/careers", "https://acme.example/careers");
  assert.equal(s.looksLikeCareersPage, true);
  assert.equal(s.redirectedToRoot, false);
});

test("a homepage served at a careers URL is NOT a careers page", () => {
  const html = "<html><head><title>Acme — the best widgets</title></head><body><h1>Buy widgets</h1><p>Widgets for all.</p></body></html>";
  const s = analyzeCareersPage(html, "https://acme.example/careers", "https://acme.example/careers");
  assert.equal(s.looksLikeCareersPage, false);
});

test("redirect from a careers path to the site root is flagged", () => {
  const html = "<html><head><title>Acme</title></head><body></body></html>";
  const s = analyzeCareersPage(html, "https://acme.example/", "https://acme.example/careers");
  assert.equal(s.redirectedToRoot, true);
});

test("a JobPosting JSON-LD block counts as a careers signal even with odd wording", () => {
  const html = `<html><head><title>Acme</title><script type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer"}</script></head><body></body></html>`;
  const s = analyzeCareersPage(html, "https://acme.example/x", "https://acme.example/x");
  assert.equal(s.looksLikeCareersPage, true);
});

test("unparseable URLs do not throw", () => {
  const s = analyzeCareersPage("<html></html>", "not a url", "also not a url");
  assert.equal(s.redirectedToRoot, false);
});
