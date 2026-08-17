import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOnecard, onecardJdText, onecardListUrl, OnecardJobSchema } from "../onecard.js";
import type { OnecardJob } from "../onecard.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "onecard",
  slug: "onecard",
  name: "Onecard",
  careersUrl: "https://www.fplabs.tech/careers/",
  tenantUrl: null,
  apiMeta: null,
};

// Reverse-engineered from fplabs.tech's inline job-card script (Strapi-v4-style); not a captured real record since no job was live at capture time.
const job: OnecardJob = {
  id: 7,
  attributes: {
    title: "Backend Engineer",
    location: "Pune",
    experience: "3-5 years",
    description: "Build and scale the Onecard backend.",
    publishedAt: "2026-06-01T10:00:00.000Z",
  },
};

test("OnecardJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(OnecardJobSchema.safeParse(job).success);
  assert.ok(
    OnecardJobSchema.safeParse({ id: 1, attributes: { title: "x" } }).success,
  );
  assert.equal(OnecardJobSchema.safeParse({ id: 1 }).success, false);
});

test("onecardListUrl builds a Strapi-style paged query", () => {
  const url = onecardListUrl(1, 25);
  assert.match(url, /^https:\/\/ibffpublic6f2461135ffd1b6a80db296ec15abf\.onrender\.com\/hr\/jobs\?/);
  assert.match(url, /pagination%5Bpage%5D=1|pagination\[page\]=1/);
  assert.match(url, /pagination%5BpageSize%5D=25|pagination\[pageSize\]=25/);
});

test("normalizeOnecard maps fields, synthesizes a per-job anchor URL, and passes location through", () => {
  const p = normalizeOnecard(company, job);
  assert.equal(p.provider, "onecard");
  assert.equal(p.externalId, "7");
  assert.equal(p.jobTitle, "Backend Engineer");
  assert.equal(p.jobUrl, "https://www.fplabs.tech/careers/#job-7");
  assert.equal(p.location, "Pune");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Build and scale the Onecard backend/);
  assert.equal(p.postedAt, "2026-06-01T10:00:00.000Z");
});

test("normalizeOnecard leaves location null when attributes.location is null (no cosmetic default)", () => {
  const p = normalizeOnecard(company, { ...job, attributes: { ...job.attributes, location: null } });
  assert.equal(p.location, null);
});

test("normalizeOnecard maps an unparseable publishedAt to null", () => {
  const p = normalizeOnecard(company, { ...job, attributes: { ...job.attributes, publishedAt: "not-a-date" } });
  assert.equal(p.postedAt, null);
});

test("onecardJdText prefixes the experience line ahead of the description", () => {
  const text = onecardJdText(job.attributes);
  assert.match(text, /Experience required: 3-5 years/);
  assert.match(text, /Build and scale the Onecard backend/);
});

test("onecardJdText tolerates null experience/description", () => {
  assert.equal(onecardJdText({ title: "x", location: null, experience: null, description: null, publishedAt: null }), "");
});
