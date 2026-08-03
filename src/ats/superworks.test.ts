// src/ats/superworks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSuperworksTenantExists,
  superworksAdapter,
  superworksListUrl,
  superworksTenantName,
  parseSuperworksList,
  parseSuperworksJd,
} from "./superworks.js";
import type { AdapterCompany } from "../types.js";
import { at, fetchSequence, htmlResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";

const company: AdapterCompany = {
  provider: "superworks",
  slug: "refrens",
  name: "Refrens",
  careersUrl: "https://refrens.superworks.com/job/listing",
  tenantUrl: "https://refrens.superworks.com/job/listing",
  apiMeta: null,
};

// ---- fixtures --------------------------------------------------------
// Real superworks.com boards are Next.js apps: the job list is NOT plain
// DOM markup you can cheerio-select — it's embedded as an escaped React
// Server Components ("Flight") payload inside
//   <script>self.__next_f.push([1,"<chunk>"])</script>
// tags. Trimmed shapes below mirror the live payload captured from
// https://refrens.superworks.com/job/listing and a job detail page on
// 2026-07-12 (field names/structure verified live; ids shortened).

function pushScript(chunk: string): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`;
}

const LIST_INITIAL_DATA = {
  companyInfo: { companyName: "Refrens Internet Pvt Ltd." },
  jobList: [
    {
      _id: "6a3d21dedb596783b0df9e72",
      name: "Customer Support Executive",
      locationInfo: [{ _id: "64b5453a5a07133123131306", name: "Surat" }],
      jobType: "68cbdb0940b49cf5d6d3c802",
      department: "64b5187d5a0713f78c0c4ed4",
    },
    {
      _id: "692ed7bae0a1666f81672944",
      name: "Prompt Engineer",
      locationInfo: [{ _id: "64b5453a5a07133123131306", name: "Surat" }],
      jobType: "68cbdb0940b49cf5d6d3c802",
      department: "64b5187d5a0713ba4d0c4ed3",
    },
    {
      // no locationInfo at all — must tolerate a missing location.
      _id: "68ecc399fb4bc3d67a722ab7",
      name: "Founder's office intern",
      locationInfo: [],
      jobType: "68cbdb0940b49cf5d6d3c802",
      department: "64b5187d5a0713ba4d0c4ed3",
    },
  ],
};

const LIST_HTML = `<html><body>${pushScript(
  `7:[null,["$","script",null,{"type":"application/ld+json"}],["$","$L13",null,{"initialData":${JSON.stringify(
    LIST_INITIAL_DATA,
  )}}]]`,
)}</body></html>`;

// Detail page: the rich JD HTML is streamed as a separate "Text" record
// referenced by "$16" (Flight protocol: `<id>:T<hex-byte-length>,<raw-bytes>`).
const JD_BODY =
  "<p>Customer Support Executive<br><br><strong>About the Role</strong></p>\n" +
  "<p>We are looking for a Customer Support Executive who is passionate about helping users and solving problems. " +
  "In this role, you will support customers via chat, email, and phone, guide them through our invoicing and payments " +
  "software, and ensure they have a seamless experience. You will work closely with the product team, continuously " +
  "learn about the platform, and contribute directly to customer satisfaction and success. This description is padded " +
  "out with additional detail about responsibilities, qualifications, and day-to-day expectations so that it comfortably " +
  "exceeds five hundred characters, matching the length of a real job description body.</p>";

function textRecord(id: string, body: string): string {
  const byteLen = Buffer.byteLength(body, "utf8").toString(16);
  return `${id}:T${byteLen},${body}`;
}

// Real pages always terminate one push-call's chunk text with "\n" (Next.js's
// RSC streaming line convention) before the next chunk's id label begins —
// verified live: "...JobDetailsSection\"]\n16:T94c,<p" on the captured
// refrens detail page. The trailing \n here mirrors that so the (?:^|\n)
// chunk-boundary anchor in resolveTextRecord matches like it does live.
const DETAIL_INITIAL_DATA_CHUNK =
  '14:["$","$L15",null,{"initialData":{"jobInfo":{"_id":"6a3d21dedb596783b0df9e72","name":"Customer Support Executive",' +
  '"jobDescription":{"description":"$16","companyPerks":"<p>Great place to work</p>"}}}}]\n';

const DETAIL_HTML = `<html><body>${pushScript(DETAIL_INITIAL_DATA_CHUNK)}${pushScript(
  textRecord("16", JD_BODY),
)}</body></html>`;

// ---- tests -------------------------------------------------------------

test("superworksListUrl derives the tenant origin and listing URL", () => {
  assert.equal(superworksListUrl(company), "https://refrens.superworks.com/job/listing");
  assert.equal(
    superworksListUrl({ ...company, tenantUrl: null }),
    "https://refrens.superworks.com/job/listing",
  );
});

test("parseSuperworksList maps the embedded initialData.jobList into postings", () => {
  const postings = parseSuperworksList(LIST_HTML, company);
  assert.equal(postings.length, 3);

  const [cse, pe, intern] = postings;
  assert.equal(cse?.provider, "superworks");
  assert.equal(cse.externalId, "6a3d21dedb596783b0df9e72");
  assert.equal(cse.companySlug, "refrens");
  assert.equal(cse.companyName, "Refrens");
  assert.equal(cse.jobTitle, "Customer Support Executive");
  assert.equal(cse.jobUrl, "https://refrens.superworks.com/job/details/6a3d21dedb596783b0df9e72");
  assert.equal(cse.location, "Surat");
  assert.equal(cse.isRemote, false);
  assert.equal(cse.jdText, "");
  assert.equal(cse.postedAt, null);

  assert.equal(pe?.jobTitle, "Prompt Engineer");
  assert.equal(pe.externalId, "692ed7bae0a1666f81672944");

  assert.equal(intern?.jobTitle, "Founder's office intern");
  assert.equal(intern.location, null);
});

test("parseSuperworksList returns [] when initialData/jobList is absent (layout change / empty board)", () => {
  assert.deepEqual(parseSuperworksList("<html><body>No jobs</body></html>", company), []);
});

test("parseSuperworksList skips a jobList row missing _id or name", () => {
  const html = `<html><body>${pushScript(
    `7:[null,{"initialData":{"jobList":[{"name":"No Id"},{"_id":"has-no-name"}]}}]`,
  )}</body></html>`;
  assert.deepEqual(parseSuperworksList(html, company), []);
});

test("parseSuperworksJd resolves the '$<id>' Flight text reference into plain text", () => {
  const jd = parseSuperworksJd(DETAIL_HTML);
  assert.ok(jd.length > 500, `expected >500 chars, got ${jd.length}`);
  assert.match(jd, /Customer Support Executive/);
  assert.match(jd, /About the Role/);
  assert.match(jd, /passionate about helping users/);
  assert.doesNotMatch(jd, /<p>|<strong>/);
});

test("parseSuperworksJd returns '' when jobDescription/description is absent", () => {
  assert.equal(parseSuperworksJd("<html><body>Not found</body></html>"), "");
});

// --- dead subdomain vs genuinely empty board -----------------------------------

// Trimmed from GET https://zzz-no-such-tenant-9x.superworks.com/job/listing
// (HTTP 200, no redirect, 13,353 bytes, captured 2026-08-03). A subdomain the
// vendor does not host serves the same Next.js shell as a real tenant, titled
// with the vendor's generic default, and its page record resolves to an RSC error
// record ("7:E{...}") instead of page data. No "initialData" appears anywhere, so
// it used to parse as a board with zero openings.
const DEAD_TENANT_HTML = `<html><head><title>Jobs &amp; Careers | Recruit Superworks</title></head><body>${pushScript(
  '0:{"P":null,"b":"FNeXjdXzPJK76i66tsPLZ","c":["","job","listing"],"i":false}\n',
)}${pushScript(
  '9:null\n' +
    'b:{"metadata":[["$","title","0",{"children":"Jobs & Careers | Recruit Superworks"}]],"error":null}\n' +
    '7:E{"digest":"1659083992"}\n',
)}</body></html>`;

// A LIVE tenant whose board is empty: the tenant-identity block still resolves
// from the subdomain, and jobList is present but has nothing in it. Mirrors the
// shape of a refrens job-detail page fetched with a nonexistent job id, whose
// initialData carried companyInfo and no jobList at all (probed 2026-08-03).
const EMPTY_BOARD_HTML = `<html><body>${pushScript(
  `7:["$","$L13",null,{"initialData":${JSON.stringify({
    companyInfo: { companyName: "Refrens Internet Pvt Ltd." },
    jobList: [],
  })}}]`,
)}</body></html>`;

/** Run `fn` and hand back whatever it threw, failing the test if it returned. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

test("superworksTenantName reads the tenant name the board resolved from its subdomain", () => {
  assert.equal(superworksTenantName(LIST_HTML), "Refrens Internet Pvt Ltd.");
  assert.equal(superworksTenantName(EMPTY_BOARD_HTML), "Refrens Internet Pvt Ltd.");
  assert.equal(superworksTenantName(DEAD_TENANT_HTML), null);
  assert.equal(superworksTenantName("<html><body>nothing</body></html>"), null);
});

test("superworksTenantName treats a blank companyName as no identity at all", () => {
  const html = `<html><body>${pushScript(
    '7:[null,{"initialData":{"companyInfo":{"companyName":"   "},"jobList":[]}}]',
  )}</body></html>`;
  assert.equal(superworksTenantName(html), null);
});

test("assertSuperworksTenantExists throws for a subdomain the vendor does not host, naming the slug", () => {
  const err = thrownBy(() => assertSuperworksTenantExists(DEAD_TENANT_HTML, "refrens"));
  assert.ok(err instanceof Error);
  assert.match(err.message, /superworks: tenant does not exist/);
  assert.match(err.message, /refrens/);
  assert.match(err.message, /companyName/);
});

test("the dead-subdomain error is charged to the company, not written off as infrastructure", () => {
  // A subdomain Superworks does not host is a per-company board defect and MUST
  // count toward the row's consecutive_failures. If any of these flipped true the
  // scheduler would retry the board forever and never quarantine it.
  const err = thrownBy(() => assertSuperworksTenantExists(DEAD_TENANT_HTML, "refrens"));
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("assertSuperworksTenantExists stays silent whenever the tenant identifies itself", () => {
  assert.doesNotThrow(() => assertSuperworksTenantExists(EMPTY_BOARD_HTML, "refrens"));
  assert.doesNotThrow(() => assertSuperworksTenantExists(LIST_HTML, "refrens"));
});

test("superworksAdapter.listPostings rejects a subdomain the vendor does not host", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(DEAD_TENANT_HTML)));
  await assert.rejects(
    () => superworksAdapter.listPostings(company),
    /superworks: tenant does not exist/,
  );
});

test("superworksAdapter.listPostings returns [] for a LIVE tenant whose board has no open roles", async (t) => {
  // The distinction the check exists for: the tenant resolves, nothing is open,
  // no error.
  stubFetch(t, fetchSequence(() => htmlResponse(EMPTY_BOARD_HTML)));
  assert.deepEqual(await superworksAdapter.listPostings(company), []);
});

test("superworksAdapter.listPostings still lists a populated board unchanged", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(LIST_HTML)));
  const postings = await superworksAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  assert.equal(at(postings, 0).externalId, "6a3d21dedb596783b0df9e72");
  assert.equal(at(postings, 0).jobUrl, "https://refrens.superworks.com/job/details/6a3d21dedb596783b0df9e72");
});

test("superworksAdapter.listPostings resolves the listing URL from a tenant_url override", async (t) => {
  // insidefpv's row: tenant_url is the full listing URL, so the origin must come
  // from it rather than from the slug.
  const insidefpv: AdapterCompany = {
    provider: "superworks",
    slug: "insidefpv",
    name: "InsideFPV",
    careersUrl: "https://insidefpv.superworks.com/job/listing",
    tenantUrl: "https://insidefpv.superworks.com/job/listing",
    apiMeta: null,
  };
  assert.equal(superworksListUrl(insidefpv), "https://insidefpv.superworks.com/job/listing");
  stubFetch(t, fetchSequence(() => htmlResponse(LIST_HTML)));
  const postings = await superworksAdapter.listPostings(insidefpv);
  assert.equal(at(postings, 0).jobUrl, "https://insidefpv.superworks.com/job/details/6a3d21dedb596783b0df9e72");
});
