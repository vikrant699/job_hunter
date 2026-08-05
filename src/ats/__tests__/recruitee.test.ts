// src/ats/recruitee.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { recruiteeBase, normalizeRecruitee, postingsFromRecruiteeJson, RecruiteeOfferSchema } from "../recruitee.js";
import type { RecruiteeOffer } from "../recruitee.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "recruitee",
  slug: "flextrade",
  name: "FlexTrade",
  careersUrl: "https://flextrade.recruitee.com",
  tenantUrl: "https://flextrade.recruitee.com",
  apiMeta: null,
};

// Trimmed real items from GET /api/offers/ (flextrade + fullcreative, 2026-07-10).
const publishedOffer: RecruiteeOffer = {
  id: 2671592,
  title: "Dashboard Automation Engineer",
  status: "published",
  description: "<p>Build automation for reporting.</p>",
  requirements: "<ul><li>2-4 years of Python experience.</li></ul>",
  location: "Pune, Mahārāshtra, India",
  remote: false,
  careers_url: "https://careers.flextrade.com/o/dashboard-automation-engineer",
  careers_apply_url: "https://careers.flextrade.com/o/dashboard-automation-engineer/c/new",
  department: "Engineering & Development",
  tags: ["FlexTCA"],
  published_at: "2026-07-09 07:03:45 UTC",
  created_at: "2026-07-09 06:57:11 UTC",
};

const remoteOffer: RecruiteeOffer = {
  id: 2644511,
  title: "Jr Operations Analyst - LinkedIn",
  status: "published",
  description: "<p>Support LinkedIn operations.</p>",
  requirements: null,
  location: "Remote job",
  remote: true,
  careers_url: "https://fullcreative.recruitee.com/o/jr-operations-analyst-linkedin",
  careers_apply_url: "https://fullcreative.recruitee.com/o/jr-operations-analyst-linkedin/c/new",
  department: "Operations",
  tags: [],
  published_at: "2026-06-01 00:00:00 UTC",
  created_at: "2026-05-30 00:00:00 UTC",
};

const closedOffer: RecruiteeOffer = {
  ...publishedOffer,
  id: 999,
  title: "Old Closed Role",
  status: "closed",
};

test("recruiteeBase prefers tenant_url origin, falls back to slug subdomain", () => {
  assert.equal(recruiteeBase(company), "https://flextrade.recruitee.com");
  assert.equal(recruiteeBase({ ...company, tenantUrl: null }), "https://flextrade.recruitee.com");
});

test("RecruiteeOfferSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(RecruiteeOfferSchema.safeParse(publishedOffer).success);
  assert.ok(
    RecruiteeOfferSchema.safeParse({
      id: 1,
      title: "Minimal",
      status: "published",
      careers_url: "https://x.recruitee.com/o/minimal",
    }).success,
  );
  assert.equal(RecruiteeOfferSchema.safeParse({ title: "no id or status" }).success, false);
});

test("normalizeRecruitee maps fields, strips HTML, concatenates description+requirements", () => {
  const p = normalizeRecruitee(company, publishedOffer);
  assert.equal(p.provider, "recruitee");
  assert.equal(p.externalId, "2671592");
  assert.equal(p.jobTitle, "Dashboard Automation Engineer");
  assert.equal(p.jobUrl, "https://careers.flextrade.com/o/dashboard-automation-engineer");
  assert.equal(p.location, "Pune, Mahārāshtra, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, "2026-07-09T07:03:45.000Z");
  assert.match(p.jdText, /Build automation for reporting/);
  assert.match(p.jdText, /2-4 years of Python experience/);
  assert.doesNotMatch(p.jdText, /<p>|<li>|<ul>/);
});

test("normalizeRecruitee honors the remote boolean and REMOTE_RE fallback on location text", () => {
  assert.equal(normalizeRecruitee(company, remoteOffer).isRemote, true);
  const noFlagButRemoteText: RecruiteeOffer = { ...publishedOffer, remote: null, location: "Remote job" };
  assert.equal(normalizeRecruitee(company, noFlagButRemoteText).isRemote, true);
});

test("normalizeRecruitee omits requirements from jdText when absent", () => {
  const p = normalizeRecruitee(company, remoteOffer);
  assert.match(p.jdText, /Support LinkedIn operations/);
  assert.equal(p.jdText.includes("\n\n"), false);
});

test("postingsFromRecruiteeJson maps offers and filters out non-published statuses", () => {
  const fixture = { offers: [publishedOffer, closedOffer, remoteOffer] };
  const postings = postingsFromRecruiteeJson(company, asJson(fixture));
  assert.equal(postings.length, 2);
  assert.deepEqual(postings.map((p) => p.externalId).sort(), ["2644511", "2671592"]);
  assert.ok(!postings.some((p) => p.jobTitle === "Old Closed Role"));
});

test("postingsFromRecruiteeJson returns an empty array for an empty board", () => {
  assert.deepEqual(postingsFromRecruiteeJson(company, { offers: [] }), []);
});

test("postingsFromRecruiteeJson throws on a malformed (schema-violating) response", () => {
  assert.throws(
    () => postingsFromRecruiteeJson(company, { offers: [{ id: "not-a-number", title: 42 }] }),
    /failed schema/,
  );
});

test("postingsFromRecruiteeJson throws when the top-level shape is wrong", () => {
  assert.throws(() => postingsFromRecruiteeJson(company, { jobs: [] }), /failed schema/);
});
