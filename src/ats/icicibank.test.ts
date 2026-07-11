// src/ats/icicibank.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptPayload,
  decryptPayload,
  parseSearchEnvelope,
  normalizeIcici,
} from "./icicibank.js";
import type { IciciJob } from "./icicibank.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "icicibank",
  slug: "icici-bank",
  name: "ICICI Bank",
  careersUrl: "https://careers.icici.bank.in/CareerApplicant/Career/Home",
  tenantUrl: null,
  apiMeta: null,
};

const job: IciciJob = {
  hc_JobID: "2204493",
  hc_JobTitle: "Credit Manager",
  hc_Location: "Across India",
  hc_JobType: "OTHERS",
  hc_Experience: "1 - 5 Yrs",
  hc_MainGroup: "CREDIT AND POLICY GROUP",
  Total_Rows: 10,
};

test("encryptPayload/decryptPayload round-trip an arbitrary JSON value", () => {
  const value = { userId: 1, PageNo: 0, limit: 12, isAllIndia: 3 };
  const blob = encryptPayload(value);
  // Ciphertext (base64) + a 16-char plaintext IV suffix, per the traced scheme.
  assert.ok(blob.length > 16);
  assert.deepEqual(decryptPayload(blob), value);
});

test("encryptPayload uses a fresh random IV each call (ciphertext differs even for identical input)", () => {
  const value = { a: 1 };
  const first = encryptPayload(value);
  const second = encryptPayload(value);
  assert.notEqual(first, second);
  assert.deepEqual(decryptPayload(first), value);
  assert.deepEqual(decryptPayload(second), value);
});

test("decryptPayload rejects a blob too short to hold a 16-char IV", () => {
  assert.throws(() => decryptPayload("short"), /too short/);
});

test("parseSearchEnvelope decrypts a page of job rows via the traced scheme", () => {
  const jobs = [job, { ...job, hc_JobID: "2547189", hc_JobTitle: "Probationary Officer Program" }];
  const envelope = { Data: encryptPayload(jobs), ResponseCode: 100 };
  const parsed = parseSearchEnvelope(envelope);
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0]?.hc_JobTitle, "Credit Manager");
});

test("parseSearchEnvelope returns null for the exhausted-pagination shape (no Data field)", () => {
  const envelope = { ResponseMessage: "No Record Found", ResponseCode: 103 };
  assert.equal(parseSearchEnvelope(envelope), null);
});

test("normalizeIcici maps fields: job-details URL, location, no JD (fetchJd handles that separately)", () => {
  const p = normalizeIcici(company, job);
  assert.equal(p.provider, "icicibank");
  assert.equal(p.externalId, "2204493");
  assert.equal(p.jobTitle, "Credit Manager");
  assert.equal(p.jobUrl, "https://careers.icici.bank.in/CareerApplicant/Career/job-details/2204493");
  assert.equal(p.location, "Across India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeIcici treats the literal string \"null\" location as absent", () => {
  const p = normalizeIcici(company, { ...job, hc_Location: "null" });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("normalizeIcici flags remote when the location string matches REMOTE_RE", () => {
  const p = normalizeIcici(company, { ...job, hc_Location: "Remote (Work from Home)" });
  assert.equal(p.isRemote, true);
});

test("normalizeIcici coerces a numeric hc_JobID to a string externalId", () => {
  const p = normalizeIcici(company, { ...job, hc_JobID: 2204493 });
  assert.equal(p.externalId, "2204493");
  assert.equal(p.jobUrl, "https://careers.icici.bank.in/CareerApplicant/Career/job-details/2204493");
});
