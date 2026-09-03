import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hdfcEncrypt,
  hdfcDecrypt,
  flattenHdfcRequisitions,
  normalizeHdfc,
  hdfcJdFromDetail,
  REQUEST_TOKEN,
  REQUEST_IV,
} from "../hdfclife.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "hdfclife",
  slug: "hdfc-life",
  name: "HDFC Life",
  careersUrl: "https://www.hdfclife.com/hdfc-careers/find-your-fit.html",
  tenantUrl: null,
  apiMeta: null,
};

test("hdfcEncrypt/hdfcDecrypt round-trip under the same token+iv (AES-256-GCM, 11-byte nonce)", () => {
  const value = { reqId: "69962", nested: [1, 2, 3] };
  const blob = hdfcEncrypt(value, REQUEST_TOKEN, REQUEST_IV);
  assert.equal(typeof blob, "string");
  assert.deepEqual(hdfcDecrypt(blob, REQUEST_TOKEN, REQUEST_IV), value);
});

test("hdfcDecrypt uses the response's own rotating token+iv", () => {
  // The server returns {token, iv} in cleartext alongside the payload; decrypt must key off those, not the static request token.
  const respToken = "0123456789abcdef0123456789abcdefEXTRA-IGNORED-TAIL";
  const respIv = REQUEST_IV;
  const payload = hdfcEncrypt({ ok: true }, respToken, respIv);
  assert.deepEqual(hdfcDecrypt(payload, respToken, respIv), { ok: true });
});

// The list response nests jobs two levels deep: results.results[] is buckets (one per JOB_ROLE), each with REQUISITION.results[] of actual jobs.
const listPayload = {
  results: {
    results: [
      {
        JOB_ROLE: "Technology",
        TOTAL: 2,
        REQUISITION: {
          results: [
            { REQID: "69962", DESIGNATION: "Full Stack Engineer", CITY: "Mumbai", LOC_NAME: "Mumbai HO", DEPT_NAME: "Technology", EXPERIENCE: "3 - 5 Years", NO_OPENING: "2" },
            { REQID: "70001", DESIGNATION: "Data Analyst", CITY: "Bengaluru", LOC_NAME: "Bengaluru", DEPT_NAME: "Analytics", EXPERIENCE: "1 - 2 Years", NO_OPENING: "1" },
          ],
        },
      },
      {
        JOB_ROLE: "Sales",
        TOTAL: 1,
        REQUISITION: { results: [{ REQID: "70050", DESIGNATION: "Corporate Agency Manager", CITY: "Pune", DEPT_NAME: "Banca" }] },
      },
      // A bucket with no requisitions must not break the flatten.
      { JOB_ROLE: "Empty", TOTAL: 0, REQUISITION: { results: [] } },
    ],
  },
};

test("flattenHdfcRequisitions pulls every job across all JOB_ROLE buckets", () => {
  const jobs = flattenHdfcRequisitions(asJson(listPayload));
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.REQID).sort(), ["69962", "70001", "70050"]);
});

test("flattenHdfcRequisitions throws on a wrong-shaped envelope (field drift)", () => {
  assert.throws(() => flattenHdfcRequisitions(asJson({ data: [] })), /schema/i);
});

test("normalizeHdfc maps designation/city/reqid; jobUrl anchors into the careers page", () => {
  const p = normalizeHdfc(company, {
    REQID: "69962", DESIGNATION: "Full Stack Engineer", CITY: "Mumbai", LOC_NAME: "Mumbai HO",
    DEPT_NAME: "Technology", EXPERIENCE: "3 - 5 Years", NO_OPENING: "2",
  });
  assert.equal(p.provider, "hdfclife");
  assert.equal(p.externalId, "69962");
  assert.equal(p.jobTitle, "Full Stack Engineer");
  assert.equal(p.location, "Mumbai");
  assert.match(p.jobUrl, /find-your-fit\.html#job-69962$/);
  assert.equal(p.jdText, ""); // JD comes from fetchJd
});

test("normalizeHdfc falls back to LOC_NAME when CITY is blank", () => {
  const p = normalizeHdfc(company, { REQID: "1", DESIGNATION: "X", CITY: "", LOC_NAME: "Gurugram Corp" });
  assert.equal(p.location, "Gurugram Corp");
});

// The JD endpoint's 'results' is a FLAT object; JOBDESCRIPTION is a NESTED OBJECT on this tenant, so the extractor must ignore non-string values.
test("hdfcJdFromDetail extracts the JOB_DESC HTML body as plain text", () => {
  const detail = { results: { REQID: "69962", JOB_DESC: "<p>Build <strong>APIs</strong>.</p>", JOBDESCRIPTION: { nested: "object" } } };
  const jd = hdfcJdFromDetail(asJson(detail));
  assert.match(jd, /Build APIs\./);
  assert.doesNotMatch(jd, /<p>/);
});

test("hdfcJdFromDetail ignores a non-string JOBDESCRIPTION and a blank JOB_DESC, using JOBDESCRIPTION only when it is a string", () => {
  // JOB_DESC blank, JOBDESCRIPTION a real string -> use it.
  const detail = { results: { REQID: "1", JOB_DESC: "", JOBDESCRIPTION: "<p>Only body.</p>" } };
  assert.match(hdfcJdFromDetail(asJson(detail)), /Only body\./);
});

test("hdfcJdFromDetail returns '' when neither field is a usable string", () => {
  assert.equal(hdfcJdFromDetail(asJson({ results: { JOBDESCRIPTION: { x: 1 }, JOB_DESC: "" } })), "");
  assert.equal(hdfcJdFromDetail(asJson({ nope: true })), "");
});
