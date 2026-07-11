// src/ats/wpjobs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wpjobsApiUrl, wpjobsLocation, normalizeWpjobs } from "./wpjobs.js";
import type { WpPost } from "./wpjobs.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "wpjobs", slug: "fibe", name: "Fibe (EarlySalary)",
  careersUrl: "https://altcont.fibe.in/jobs/", tenantUrl: "https://altcont.fibe.in",
  apiMeta: null,
};

// Fixture 1 — mirrors Fibe's confirmed live shape: no acf/meta location (acf
// only carries an external-ATS redirect payload), location comes from the
// `jobpost_location` taxonomy, exposed via `_embed=1` as `_embedded['wp:term']`.
const postWithEmbeddedLocation: WpPost = {
  id: 47816,
  date: "2025-01-21T15:38:43",
  date_gmt: "2025-01-21T10:08:43",
  link: "https://altcont.fibe.in/jobs/growth-manager-ed-tech/",
  title: { rendered: "Growth Manager &#8211; ED Tech" },
  content: { rendered: "<p><strong>Experience: </strong>3 &#8211; 6 years</p>\n<ul><li>Own merchant growth.</li></ul>" },
  class_list: ["post-47816", "jobpost", "jobpost_location-bangalore"],
  acf: { job_opening_external_redirection: "opaque-redirect-payload" },
  meta: null,
  _embedded: { "wp:term": [[{ taxonomy: "jobpost_category", name: "BNPL" }], [{ taxonomy: "jobpost_location", name: "Bangalore" }]] },
};

// Fixture 2 — no _embedded (e.g. embedding disabled), location comes from a
// plain `acf` field instead; remote-looking value should set isRemote.
const postWithAcfLocation: WpPost = {
  id: 100,
  date: "2026-02-01T09:00:00",
  date_gmt: null,
  link: "https://example.com/jobs/backend-engineer/",
  title: { rendered: "Backend Engineer " },
  content: { rendered: "<p>Build APIs.</p>" },
  class_list: ["post-100", "jobpost"],
  acf: { job_location: "Remote - India" },
  meta: null,
  _embedded: null,
};

// Fixture 3 — no _embedded, no acf/meta location; falls all the way through
// to a "Location:" label parsed out of the body copy.
const postWithContentLocation: WpPost = {
  id: 101,
  date: "2026-02-02T09:00:00",
  date_gmt: "2026-02-02T03:30:00",
  link: "https://example.com/jobs/qa-lead/",
  title: { rendered: "QA Lead" },
  content: { rendered: "<p><strong>Job location: </strong>Pune</p><p>Own our test strategy.</p>" },
  class_list: null,
  acf: null,
  meta: null,
  _embedded: null,
};

test("wpjobsApiUrl builds the paged, embedded list URL with the default postType", () => {
  assert.equal(
    wpjobsApiUrl(company, 1),
    "https://altcont.fibe.in/wp-json/wp/v2/jobpost?per_page=100&page=1&order=desc&_embed=1",
  );
});

test("wpjobsApiUrl honors apiMeta.postType for sites using a different CPT slug", () => {
  const c: AdapterCompany = { ...company, apiMeta: { postType: "vacancy" } };
  assert.equal(
    wpjobsApiUrl(c, 2),
    "https://altcont.fibe.in/wp-json/wp/v2/vacancy?per_page=100&page=2&order=desc&_embed=1",
  );
});

test("wpjobsLocation prefers the embedded taxonomy term name (Fibe's confirmed live shape)", () => {
  assert.equal(wpjobsLocation(postWithEmbeddedLocation), "Bangalore");
});

test("wpjobsLocation falls back to class_list's <taxonomy>_location-<slug> class when unembedded", () => {
  const post: WpPost = { ...postWithEmbeddedLocation, _embedded: null };
  assert.equal(wpjobsLocation(post), "Bangalore");
});

test("wpjobsLocation falls back to an acf field that looks location-related", () => {
  assert.equal(wpjobsLocation(postWithAcfLocation), "Remote - India");
});

test("wpjobsLocation skips acf fields that look like a redirect payload", () => {
  const post: WpPost = { ...postWithAcfLocation, acf: { job_opening_external_redirection: "not-a-location" } };
  assert.equal(wpjobsLocation(post), null);
});

test("wpjobsLocation falls back to a 'Location:' label embedded in the body copy", () => {
  assert.equal(wpjobsLocation(postWithContentLocation), "Pune");
});

test("wpjobsLocation returns null when no signal is available anywhere", () => {
  const post: WpPost = { ...postWithContentLocation, content: { rendered: "<p>No location mentioned.</p>" } };
  assert.equal(wpjobsLocation(post), null);
});

test("normalizeWpjobs maps fields: entity-stripped title, html-stripped JD, link, date_gmt over date", () => {
  const p = normalizeWpjobs(company, postWithEmbeddedLocation);
  assert.equal(p.provider, "wpjobs");
  assert.equal(p.externalId, "47816");
  assert.equal(p.jobTitle, "Growth Manager – ED Tech");
  assert.equal(p.jobUrl, "https://altcont.fibe.in/jobs/growth-manager-ed-tech/");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Own merchant growth\./);
  assert.doesNotMatch(p.jdText, /<p>|<li>/);
  assert.equal(p.postedAt, new Date("2025-01-21T10:08:43Z").toISOString());
});

test("normalizeWpjobs sets isRemote from a remote-looking acf location and falls back to `date` without date_gmt", () => {
  const p = normalizeWpjobs(company, postWithAcfLocation);
  assert.equal(p.location, "Remote - India");
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, new Date("2026-02-01T09:00:00").toISOString());
});

test("normalizeWpjobs strips tags from a content-derived location and leaves the JD intact otherwise", () => {
  const p = normalizeWpjobs(company, postWithContentLocation);
  assert.equal(p.location, "Pune");
  assert.match(p.jdText, /Own our test strategy\./);
  assert.equal(p.postedAt, new Date("2026-02-02T03:30:00Z").toISOString());
});

test("normalizeWpjobs leaves location null and isRemote false with no location signal at all", () => {
  const post: WpPost = { ...postWithContentLocation, content: { rendered: "<p>No location mentioned.</p>" } };
  const p = normalizeWpjobs(company, post);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});
