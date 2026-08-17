import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  redbusHash,
  parseRedbusTimestamp,
  normalizeRedbus,
  REDBUS_CAREERS_URL,
} from "../redbus.js";
import type { RedbusJob } from "../redbus.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "redbus", slug: "redbus", name: "redBus",
  careersUrl: "https://www.redbus.in/careers/jobs",
  tenantUrl: null, apiMeta: null,
};

const job: RedbusJob = {
  job_id: "a69afe3782c364",
  job_title: "Business Analyst",
  department: "Business Development",
  location: ["Bangalore, Karnataka, India (Bangalore_RBM)"],
  location_city: ["Bangalore"],
  location_country: "India",
  is_remote: 0,
  job_created_timestamp: "10-03-2026 14:55:12",
  job_updated_timestamp: "13-07-2026 00:01:57",
};

test("redbusHash reproduces the client bundle's sha512(salt + timestamp) signature", () => {
  const ts = 1783915289;
  const expected = createHash("sha512")
    .update("Admindarwinbox@go-mmt.com9ee1f8acd90924a81180267e97609291" + ts)
    .digest("hex");
  assert.equal(redbusHash(ts), expected);
  assert.equal(
    redbusHash(ts),
    "69d24d1c2419801720885f6aa3515e8d53e7851fa284569bac5c90184a7a57f8a15dffcef429e78874dcb98e8a0d45028b709316095dc68e4531c9e4922d4efb",
  );
});

test("redbusHash changes with the timestamp (not a constant)", () => {
  assert.notEqual(redbusHash(1), redbusHash(2));
});

test("parseRedbusTimestamp converts DD-MM-YYYY HH:mm:ss (UTC) to ISO", () => {
  assert.equal(parseRedbusTimestamp("10-03-2026 14:55:12"), "2026-03-10T14:55:12.000Z");
});

test("parseRedbusTimestamp returns null for missing/unparseable input", () => {
  assert.equal(parseRedbusTimestamp(null), null);
  assert.equal(parseRedbusTimestamp(undefined), null);
  assert.equal(parseRedbusTimestamp("not-a-date"), null);
});

test("normalizeRedbus maps fields: prefers job_updated_timestamp, location precedence, static careers URL", () => {
  const p = normalizeRedbus(company, job);
  assert.equal(p.provider, "redbus");
  assert.equal(p.externalId, "a69afe3782c364");
  assert.equal(p.jobTitle, "Business Analyst");
  assert.equal(p.jobUrl, REDBUS_CAREERS_URL);
  assert.equal(p.location, "Bangalore, Karnataka, India (Bangalore_RBM)");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, "2026-07-13T00:01:57.000Z");
});

test("normalizeRedbus falls back to location_city then location_country when location[] is absent", () => {
  const p1 = normalizeRedbus(company, { ...job, location: null });
  assert.equal(p1.location, "Bangalore");
  const p2 = normalizeRedbus(company, { ...job, location: null, location_city: null });
  assert.equal(p2.location, "India");
});

test("normalizeRedbus: is_remote=1 sets isRemote true even without a remote-looking location string", () => {
  const p = normalizeRedbus(company, { ...job, is_remote: 1, location: ["Bangalore"] });
  assert.equal(p.isRemote, true);
});

test("normalizeRedbus falls back to job_created_timestamp when job_updated_timestamp is absent", () => {
  const p = normalizeRedbus(company, { ...job, job_updated_timestamp: null });
  assert.equal(p.postedAt, "2026-03-10T14:55:12.000Z");
});
