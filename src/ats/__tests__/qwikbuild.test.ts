import { test } from "node:test";
import assert from "node:assert/strict";
import { qwikbuildAdapter, qwikbuildJobUrl, qwikbuildOpeningsUrl } from "../qwikbuild.js";
import type { AdapterCompany } from "../../types.js";
import { rejectionOf } from "../../__tests__/caught.js";
import { at, fetchSequence, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const APP_ID = "07140438-1e20-45f6-be5d-ff49d7bfff78";
const BASE = `https://platform.qwikbuild.com/api/apps/v1/${APP_ID}/server/data/public/openings`;

function company(overrides: Partial<AdapterCompany> = {}): AdapterCompany {
  return mkAdapterCompany(
    { provider: "qwikbuild", slug: "medibuddy", name: "MediBuddy", careersUrl: "https://ats.medibuddy.in/careers/" },
    { apiMeta: { appId: APP_ID }, ...overrides },
  );
}

function opening(n: number, location = "Bengaluru") {
  return {
    refCode: `JOB-${n}`,
    title: `Role ${n}`,
    location,
    jobType: "full_time",
    workMode: "none",
    team: "Engineering",
    slug: `role-${n}-abc`,
    summary: "short summary",
  };
}

function page(items: object[], p: number, total: number) {
  return { success: true, data: items, total, page: p, limit: 20 };
}

test("qwikbuildOpeningsUrl keys the app id from apiMeta and pages 1-based", () => {
  assert.equal(qwikbuildOpeningsUrl(company(), 1), `${BASE}?page=1`);
  assert.equal(qwikbuildOpeningsUrl(company(), 3), `${BASE}?page=3`);
});

test("qwikbuildOpeningsUrl throws without apiMeta.appId", () => {
  assert.throws(() => qwikbuildOpeningsUrl(company({ apiMeta: null }), 1), /appId/);
});

test("qwikbuildJobUrl hangs the slug off the careers URL", () => {
  assert.equal(qwikbuildJobUrl(company(), "network-engineer-mf7a60"), "https://ats.medibuddy.in/careers/network-engineer-mf7a60");
});

test("listPostings pages until the board is exhausted and normalizes openings", async (t) => {
  const urls: string[] = [];
  const seq = fetchSequence(
    () => jsonResponse(page(Array.from({ length: 20 }, (_, i) => opening(i)), 1, 21)),
    () => jsonResponse(page([opening(20, "Work From Home")], 2, 21)),
  );
  stubFetch(t, (input, init) => {
    urls.push(String(input));
    return seq(input, init);
  });
  const postings = await qwikbuildAdapter.listPostings(company());
  assert.equal(postings.length, 21);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], `${BASE}?page=2`);
  const p = at(postings, 0);
  assert.equal(p.provider, "qwikbuild");
  assert.equal(p.externalId, "role-0-abc");
  assert.equal(p.jobTitle, "Role 0");
  assert.equal(p.location, "Bengaluru");
  assert.equal(p.jobUrl, "https://ats.medibuddy.in/careers/role-0-abc");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(at(postings, 20).isRemote, true);
});

test("listPostings suffixes apiMeta.country onto bare town names", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(page([opening(1, "Bhubaneshwar")], 1, 1))));
  const postings = await qwikbuildAdapter.listPostings(company({ apiMeta: { appId: APP_ID, country: "India" } }));
  assert.equal(at(postings, 0).location, "Bhubaneshwar, India");
});

test("listPostings does not double a country already in the location", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(page([opening(1, "Pune, India")], 1, 1))));
  const postings = await qwikbuildAdapter.listPostings(company({ apiMeta: { appId: APP_ID, country: "India" } }));
  assert.equal(at(postings, 0).location, "Pune, India");
});

test("listPostings stops on an empty page when the last page is exactly full", async (t) => {
  stubFetch(t, fetchSequence(
    () => jsonResponse({ success: true, data: Array.from({ length: 20 }, (_, i) => opening(i)) }),
    () => jsonResponse({ success: true, data: [] }),
  ));
  assert.equal((await qwikbuildAdapter.listPostings(company())).length, 20);
});

test("listPostings rejects a malformed page", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ success: false })));
  const err = await rejectionOf(qwikbuildAdapter.listPostings(company()));
  assert.match(String(err), /schema/);
});

test("fetchJd reads jobDescription from the detail endpoint as plain text", async (t) => {
  const urls: string[] = [];
  const seq = fetchSequence(
    () => jsonResponse(page([opening(1)], 1, 1)),
    () => jsonResponse({ success: true, data: { ...opening(1), jobDescription: "<p><b>6+ years</b> of network engineering</p>" } }),
  );
  stubFetch(t, (input, init) => {
    urls.push(String(input));
    return seq(input, init);
  });
  const [p] = await qwikbuildAdapter.listPostings(company());
  assert.ok(p);
  const jd = await qwikbuildAdapter.fetchJd?.(company(), p);
  assert.equal(urls[1], `${BASE}/role-1-abc`);
  assert.equal(jd, "6+ years of network engineering");
});

test("fetchJd returns empty on a malformed detail body", async (t) => {
  stubFetch(t, fetchSequence(
    () => jsonResponse(page([opening(1)], 1, 1)),
    () => jsonResponse({ success: true, data: null }),
  ));
  const [p] = await qwikbuildAdapter.listPostings(company());
  assert.ok(p);
  assert.equal(await qwikbuildAdapter.fetchJd?.(company(), p), "");
});
