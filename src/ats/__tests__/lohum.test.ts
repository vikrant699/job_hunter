import { test } from "node:test";
import assert from "node:assert/strict";
import { LohumJobSchema, LohumResponseSchema, normalizeLohum, lohumListUrl } from "../lohum.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "lohum", slug: "lohum", name: "Lohum",
  careersUrl: "https://www.lohum.com/careers",
  tenantUrl: null, apiMeta: null,
};

const RESPONSE = [
  {
    id: 141,
    designation: "Plant Finance Manager",
    experience: 2,
    jobtype: "Full Time",
    location: "Greater Noida",
    jobdescription: "<ul><li><p><strong>Job Title:</strong> Plant Finance Manager<br></p></li></ul>",
    languagetype: 1,
  },
  {
    id: 64,
    designation: "Executive - EHS",
    experience: 1,
    jobtype: "Full Time",
    location: "Greater Noida",
    jobdescription: "<p>Support EHS compliance at the plant.</p>",
    languagetype: 1,
  },
];

test("lohumListUrl points at the getlist endpoint", () => {
  assert.equal(lohumListUrl(), "https://lohum.com/api/Currentopening/getlist");
});

test("LohumResponseSchema reads the bare array of openings", () => {
  const parsed = LohumResponseSchema.parse(RESPONSE);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.designation, "Plant Finance Manager");
});

test("LohumJobSchema rejects a record with no id", () => {
  assert.equal(LohumJobSchema.safeParse({ designation: "No id" }).success, false);
});

test("normalizeLohum maps designation/location/HTML-stripped JD, falls back to careers URL", () => {
  const p = normalizeLohum(company, LohumJobSchema.parse(RESPONSE[0]));
  assert.equal(p.provider, "lohum");
  assert.equal(p.externalId, "141");
  assert.equal(p.jobTitle, "Plant Finance Manager");
  assert.equal(p.location, "Greater Noida");
  assert.equal(p.jobUrl, "https://www.lohum.com/careers");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Job Title: Plant Finance Manager/);
  assert.doesNotMatch(p.jdText, /<ul>|<li>|<p>|<strong>/);
});

test("normalizeLohum detects a remote location", () => {
  const remote = LohumJobSchema.parse({ ...RESPONSE[1], location: "Remote" });
  const p = normalizeLohum(company, remote);
  assert.equal(p.isRemote, true);
});

test("normalizeLohum treats a blank location as null, not remote", () => {
  const blank = LohumJobSchema.parse({ ...RESPONSE[1], location: "" });
  const p = normalizeLohum(company, blank);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});
