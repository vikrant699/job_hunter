// src/ats/nineninegames.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nineNineGamesShouldKeep,
  nineNineGamesJobUrl,
  normalizeNineNineGamesJob,
  type NineNineGamesJob,
} from "./nineninegames.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "nineninegames",
  slug: "99games",
  name: "99Games",
  careersUrl: "https://www.99games.in/careers",
  tenantUrl: null,
  apiMeta: null,
};

// --- nineNineGamesShouldKeep -------------------------------------------------

const baseJob: NineNineGamesJob = {
  _id: "68eca9cfb775116422c36894",
  jobTitle: "Analyst- Game Data ",
  jobLocation: "Udupi",
  description: "<p><strong>About us:</strong></p><p>We build mobile games.</p>",
  publish: true,
  last_modified_on: "2026-01-13T05:45:39.000Z",
};

test("nineNineGamesShouldKeep keeps a published job", () => {
  assert.equal(nineNineGamesShouldKeep(baseJob), true);
});

test("nineNineGamesShouldKeep keeps a job with publish missing", () => {
  const { publish: _publish, ...rest } = baseJob;
  assert.equal(nineNineGamesShouldKeep(rest), true);
});

test("nineNineGamesShouldKeep drops an unpublished job", () => {
  assert.equal(nineNineGamesShouldKeep({ ...baseJob, publish: false }), false);
});

// --- nineNineGamesJobUrl -----------------------------------------------------

test("nineNineGamesJobUrl builds a careersUrl + #job-<id> fragment", () => {
  assert.equal(
    nineNineGamesJobUrl(company, "68eca9cfb775116422c36894"),
    "https://www.99games.in/careers#job-68eca9cfb775116422c36894",
  );
});

test("nineNineGamesJobUrl strips a trailing slash on careersUrl before appending the fragment", () => {
  const trailing: AdapterCompany = { ...company, careersUrl: "https://www.99games.in/careers/" };
  assert.equal(
    nineNineGamesJobUrl(trailing, "abc123"),
    "https://www.99games.in/careers#job-abc123",
  );
});

// --- normalizeNineNineGamesJob -----------------------------------------------

test("normalizeNineNineGamesJob maps fields correctly", () => {
  const p = normalizeNineNineGamesJob(company, baseJob);
  assert.equal(p.provider, "nineninegames");
  assert.equal(p.externalId, "68eca9cfb775116422c36894");
  assert.equal(p.companySlug, "99games");
  assert.equal(p.companyName, "99Games");
  assert.equal(p.jobTitle, "Analyst- Game Data"); // trimmed
  assert.equal(p.jobUrl, "https://www.99games.in/careers#job-68eca9cfb775116422c36894");
  assert.equal(p.location, "Udupi");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, new Date("2026-01-13T05:45:39.000Z").toISOString());
});

test("normalizeNineNineGamesJob strips inline HTML into plain-text jdText (no HTML tags survive)", () => {
  const p = normalizeNineNineGamesJob(company, baseJob);
  assert.match(p.jdText, /About us:/);
  assert.match(p.jdText, /We build mobile games\./);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
});

test("normalizeNineNineGamesJob maps a null location to null, not a REMOTE_RE match", () => {
  const p = normalizeNineNineGamesJob(company, { ...baseJob, jobLocation: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("normalizeNineNineGamesJob flags isRemote from a REMOTE_RE-matching location", () => {
  const p = normalizeNineNineGamesJob(company, { ...baseJob, jobLocation: "Remote - India" });
  assert.equal(p.isRemote, true);
});

test("normalizeNineNineGamesJob maps an unparseable/absent last_modified_on to null postedAt", () => {
  const p = normalizeNineNineGamesJob(company, { ...baseJob, last_modified_on: null });
  assert.equal(p.postedAt, null);
});

test("normalizeNineNineGamesJob maps an empty description to empty jdText", () => {
  const p = normalizeNineNineGamesJob(company, { ...baseJob, description: null });
  assert.equal(p.jdText, "");
});
