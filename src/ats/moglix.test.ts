// src/ats/moglix.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moglixEncrypt,
  moglixDecrypt,
  unwrapEnvelope,
  parseListResponse,
  normalizeMoglix,
  parseDdMmYyyy,
} from "./moglix.js";
import type { MoglixJob } from "./moglix.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "moglix",
  slug: "moglix",
  name: "Moglix",
  careersUrl: "https://moglix.flexiele.com/careers/moglix/jobs",
  tenantUrl: null,
  apiMeta: null,
};

const job: MoglixJob = {
  id: 4001,
  job_title: "Executive/Sr. Executive -  BTL (Marketing)",
  date_posted: "10-07-2026",
  job_category: null,
  location: "Noida",
  job_type: "Business Regular",
  employee_status: null,
  jd: "<p>Some <strong>JD</strong> body.</p>",
  business_unit_name: "Central",
};

test("moglixEncrypt/moglixDecrypt round-trip an arbitrary JSON string (CryptoJS OpenSSL Salted__ scheme)", () => {
  const passphrase = "2e35f242a46d67eeb74aabc37d5e5d05";
  const plaintext = JSON.stringify({ formCode: "FRM0001379", gridCode: "GRD0000837", skip: 0, take: 50000 });
  const blob = moglixEncrypt(plaintext, passphrase);
  assert.match(blob, /^U2FsdGVkX1/); // base64 of "Salted__" + salt + ciphertext
  assert.equal(moglixDecrypt(blob, passphrase), plaintext);
});

test("moglixEncrypt uses a fresh random salt each call (ciphertext differs even for identical input)", () => {
  const passphrase = "2e35f242a46d67eeb74aabc37d5e5d05";
  const first = moglixEncrypt("{}", passphrase);
  const second = moglixEncrypt("{}", passphrase);
  assert.notEqual(first, second);
  assert.equal(moglixDecrypt(first, passphrase), "{}");
  assert.equal(moglixDecrypt(second, passphrase), "{}");
});

test("moglixDecrypt throws on a blob with the wrong passphrase", () => {
  const blob = moglixEncrypt("{}", "2e35f242a46d67eeb74aabc37d5e5d05");
  assert.throws(() => moglixDecrypt(blob, "wrong-passphrase-00000000000000"));
});

test("unwrapEnvelope extracts the sole dynamic-key ciphertext value", () => {
  const envelope = { fc8ece00: "U2FsdGVkX1abc123" };
  assert.equal(unwrapEnvelope(envelope), "U2FsdGVkX1abc123");
});

test("unwrapEnvelope throws on an envelope with zero or multiple keys", () => {
  assert.throws(() => unwrapEnvelope({}));
  assert.throws(() => unwrapEnvelope({ a: "x", b: "y" }));
});

test("unwrapEnvelope throws on a non-object", () => {
  assert.throws(() => unwrapEnvelope("nope"));
  assert.throws(() => unwrapEnvelope(null));
});

test("parseListResponse decrypts+validates a full envelope round-trip", () => {
  const passphrase = "2e35f242a46d67eeb74aabc37d5e5d05";
  const payload = { err: [], errCode: [], data: { rows: [job], count: 1 } };
  const ciphertext = moglixEncrypt(JSON.stringify(payload), passphrase);
  const envelope = { deadbeef: ciphertext };
  const rows = parseListResponse(envelope, passphrase);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.job_title, job.job_title);
});

test("parseDdMmYyyy converts moglix's DD-MM-YYYY date_posted to an ISO string", () => {
  const iso = parseDdMmYyyy("10-07-2026");
  assert.ok(iso);
  assert.equal(iso?.slice(0, 10), "2026-07-10");
});

test("parseDdMmYyyy returns null for a missing/malformed date", () => {
  assert.equal(parseDdMmYyyy(null), null);
  assert.equal(parseDdMmYyyy("not-a-date"), null);
});

test("normalizeMoglix maps fields: id, JD html->text, job URL, date_posted->postedAt", () => {
  const p = normalizeMoglix(company, job);
  assert.equal(p.provider, "moglix");
  assert.equal(p.externalId, "4001");
  assert.equal(p.jobTitle, job.job_title);
  assert.equal(p.jobUrl, "https://moglix.flexiele.com/careers/moglix/jobs?job=4001");
  assert.equal(p.location, "Noida");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "Some JD body.");
  assert.equal(p.postedAt?.slice(0, 10), "2026-07-10");
});

test("normalizeMoglix flags remote when location matches REMOTE_RE", () => {
  const p = normalizeMoglix(company, { ...job, location: "Remote (Work from Home)" });
  assert.equal(p.isRemote, true);
});

test("normalizeMoglix treats a null location as absent", () => {
  const p = normalizeMoglix(company, { ...job, location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("normalizeMoglix coerces numeric id to a string externalId", () => {
  const p = normalizeMoglix(company, { ...job, id: 9999 });
  assert.equal(p.externalId, "9999");
  assert.equal(p.jobUrl, "https://moglix.flexiele.com/careers/moglix/jobs?job=9999");
});
