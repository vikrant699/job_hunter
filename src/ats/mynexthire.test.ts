// src/ats/mynexthire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMyNextHire,
  mynexthireBase,
  mynexthireJobUrl,
  mynexthireAdapter,
  MyNextHireJobSchema,
  type MyNextHireJob,
} from "./mynexthire.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "mynexthire",
  slug: "swiggy",
  name: "Swiggy",
  careersUrl: "https://swiggy.mynexthire.com/employer/jobs/careers",
  tenantUrl: "https://swiggy.mynexthire.com",
  apiMeta: null,
};

// Trimmed real shape from POST /employer/careers/reqlist/get (Swiggy).
const openJob: MyNextHireJob = {
  reqId: 27890,
  statusId: 3,
  reqTitle: "Key Account Manager II",
  location: "Mumbai",
  locationAddress: "Mumbai",
  jdDisplay: "About Swiggy\n\nOwn a portfolio of multi-outlet restaurants.",
  approvedOn: "2026-07-10T08:54:43.982+0000",
};

const closedJob: MyNextHireJob = {
  reqId: 11111,
  statusId: 5, // not the public-open status — must be filtered out
  reqTitle: "Old Closed Req",
  location: "Bangalore",
  locationAddress: "Bangalore",
  jdDisplay: "This one should not appear.",
  approvedOn: "2025-01-01T00:00:00.000+0000",
};

const remoteJob: MyNextHireJob = {
  reqId: 22222,
  statusId: 3,
  reqTitle: "Remote Support Engineer",
  location: "Remote",
  locationAddress: null,
  jdDisplay: "Work from anywhere in India.",
  approvedOn: "2026-07-01T00:00:00.000+0000",
};

test("mynexthireBase prefers tenant_url origin, falls back to slug subdomain", () => {
  assert.equal(mynexthireBase(company), "https://swiggy.mynexthire.com");
  assert.equal(
    mynexthireBase({ ...company, tenantUrl: null }),
    "https://swiggy.mynexthire.com",
  );
});

test("MyNextHireJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(MyNextHireJobSchema.safeParse(openJob).success);
  assert.ok(MyNextHireJobSchema.safeParse({ reqId: 1, statusId: 3, reqTitle: "x" }).success);
  assert.equal(MyNextHireJobSchema.safeParse({ reqTitle: "no reqId or statusId" }).success, false);
});

test("mynexthireJobUrl builds a link the vendor's own SPA can decode", () => {
  const url = mynexthireJobUrl(company, 27890);
  assert.match(url, /^https:\/\/swiggy\.mynexthire\.com\/employer\/jobs\/careers\?/);

  // Reproduce careers.js's own parsing: decodeURIComponent(query).split("&"),
  // each pair split on "=" (see basePageClass ctor in careers.js).
  const query = at(url.split("?"), 1);
  const decoded = decodeURIComponent(query);
  const params: Record<string, string> = {};
  for (const pair of decoded.split("&")) {
    const [k, v] = pair.split("=");
    assert(k);
    assert(v);
    params[k] = v;
  }
  assert.equal(params.src, "careers");
  assert(params.p);
  const recovered: unknown = JSON.parse(Buffer.from(params.p, "base64").toString("utf8"));
  assert.deepEqual(recovered, {
    pageType: "jd",
    cvSource: "careers",
    reqId: 27890,
    requester: { id: "", code: "", name: "" },
    page: "careers",
    bufilter: -1,
    customFields: {},
  });
});

test("normalizeMyNextHire maps fields, uses jdDisplay as jdText, non-remote", () => {
  const p = normalizeMyNextHire(company, openJob);
  assert.equal(p.provider, "mynexthire");
  assert.equal(p.externalId, "27890");
  assert.equal(p.jobTitle, "Key Account Manager II");
  assert.equal(p.location, "Mumbai");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Own a portfolio of multi-outlet restaurants/);
  assert.equal(p.postedAt, new Date("2026-07-10T08:54:43.982+0000").toISOString());
});

test("normalizeMyNextHire falls back to locationAddress when location is absent", () => {
  const p = normalizeMyNextHire(company, { ...openJob, location: null });
  assert.equal(p.location, "Mumbai");
});

test("normalizeMyNextHire detects remote via REMOTE_RE against location", () => {
  const p = normalizeMyNextHire(company, remoteJob);
  assert.equal(p.isRemote, true);
});

test("normalizeMyNextHire returns null postedAt when approvedOn is absent", () => {
  const p = normalizeMyNextHire(company, { ...openJob, approvedOn: null });
  assert.equal(p.postedAt, null);
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("mynexthireAdapter.listPostings filters to the open statusId and normalizes the rest", async () => {
  let capturedBody: unknown;
  stubFetch(async (_url, init) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(
      JSON.stringify({ reqDetailsBOList: [openJob, closedJob, remoteJob] }),
      { status: 200 },
    );
  });

  try {
    const postings = await mynexthireAdapter.listPostings(company);
    assert.deepEqual(
      postings.map((p) => p.externalId).sort(),
      ["22222", "27890"],
    );
    assert.deepEqual(capturedBody, { source: "careers", code: "", filterByBuId: -1 });
  } finally {
    restoreFetch();
  }
});
