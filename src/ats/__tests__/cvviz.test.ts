import { test } from "node:test";
import assert from "node:assert/strict";
import { cvvizPageSlug, cvvizJobsUrl, cvvizJobUrl, cvvizLocation, normalizeCvviz, parseCvvizPage, cvvizAdapter } from "../cvviz.js";
import type { AdapterCompany } from "../../types.js";
import { asJson, at, fetchSequence, jsonResponse, stubFetch } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "cvviz",
  slug: "stackby",
  name: "Stackby",
  careersUrl: "https://jobs.cvviz.com/stackby",
  tenantUrl: "https://jobs.cvviz.com/stackby",
  apiMeta: { employerId: "1753" },
};

test("cvvizPageSlug reads the first path segment of the tenant/careers URL, else the registry slug", () => {
  assert.equal(cvvizPageSlug(company), "stackby");
  assert.equal(cvvizPageSlug({ ...company, tenantUrl: "https://jobs.cvviz.com/acme-corp/" }), "acme-corp");
  assert.equal(cvvizPageSlug({ ...company, tenantUrl: null, careersUrl: "https://jobs.cvviz.com/" }), "stackby");
  assert.equal(cvvizPageSlug({ ...company, tenantUrl: null, careersUrl: "not a url" }), "stackby");
});

test("cvvizPageSlug ignores a legacy apiMeta.employerId and needs no apiMeta at all", () => {
  assert.equal(cvvizPageSlug({ ...company, apiMeta: null }), "stackby");
});

test("cvvizJobsUrl builds the public career-pages jobs endpoint keyed by page slug", () => {
  assert.equal(
    cvvizJobsUrl("stackby", 2, 100),
    "https://api.cvviz.com/public/career-pages/stackby/jobs?context=employer&page=2&pageSize=100",
  );
});

test("cvvizJobUrl mirrors the SPA's job_<id>_<Title_With_Underscores> route with slashes as dashes", () => {
  assert.equal(cvvizJobUrl("stackby", "33653", "Software Engineer"), "https://jobs.cvviz.com/stackby/job_33653_Software_Engineer");
  assert.equal(cvvizJobUrl("stackby", "1", "UI/UX Designer"), "https://jobs.cvviz.com/stackby/job_1_UI-UX_Designer");
  assert.equal(cvvizJobUrl("stackby", "2", "Sales & Marketing #1?"), "https://jobs.cvviz.com/stackby/job_2_Sales_%26_Marketing_%231%3F");
});

test("cvvizLocation joins city, state, country; skips blanks; null when all empty", () => {
  assert.equal(cvvizLocation({ city: "Surat", state: "Gujarat", country: "India" }), "Surat, Gujarat, India");
  assert.equal(cvvizLocation({ city: "Bengaluru", state: null, country: "India" }), "Bengaluru, India");
  assert.equal(cvvizLocation({ city: null, state: null, country: null }), null);
  assert.equal(cvvizLocation(null), null);
});

const rawJob = {
  id: 52374,
  tenantId: 1753,
  title: "Inside Sales Executives",
  code: "Business_D_1668508290",
  description: "<div><strong>Description</strong> :</div><ul><li>Manage Inbound leads.</li></ul>",
  location: { city: "Surat", state: "Gujarat", country: "India", postalCode: "395007", remote: false },
  publication: { status: "active", createdAt: "2022-11-15T10:37:48.000Z", updatedAt: null },
};

test("normalizeCvviz maps id/title/location/inline JD/posted date and the live job URL", () => {
  const p = normalizeCvviz(company, "stackby", { ...rawJob, id: "52374" });
  assert.equal(p.provider, "cvviz");
  assert.equal(p.externalId, "52374");
  assert.equal(p.jobTitle, "Inside Sales Executives");
  assert.equal(p.location, "Surat, Gujarat, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jobUrl, "https://jobs.cvviz.com/stackby/job_52374_Inside_Sales_Executives");
  assert.match(p.jdText, /Manage Inbound leads\./);
  assert.doesNotMatch(p.jdText, /<li>/);
  assert.equal(p.postedAt, "2022-11-15T10:37:48.000Z");
});

test("normalizeCvviz takes isRemote from the remote flag or a remote-looking location", () => {
  assert.equal(normalizeCvviz(company, "stackby", { ...rawJob, id: "52374", location: { ...rawJob.location, remote: true } }).isRemote, true);
  assert.equal(
    normalizeCvviz(company, "stackby", { ...rawJob, id: "52374", location: { city: "Remote", state: null, country: "India", remote: null } }).isRemote,
    true,
  );
});

test("normalizeCvviz tolerates a missing location, description and publication", () => {
  const p = normalizeCvviz(company, "stackby", { id: "7", title: "Engineer" });
  assert.equal(p.location, null);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("parseCvvizPage validates the {data, meta.pagination} envelope and reads totalItems", () => {
  const page = parseCvvizPage(
    company,
    "stackby",
    asJson({ data: [rawJob, { ...rawJob, id: 52375 }], meta: { pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 } } }),
  );
  assert.equal(page.total, 2);
  assert.deepEqual(page.postings.map((p) => p.externalId), ["52374", "52375"]);
});

test("parseCvvizPage tolerates a missing meta (null total) and an empty page", () => {
  const page = parseCvvizPage(company, "stackby", asJson({ data: [] }));
  assert.equal(page.total, null);
  assert.equal(page.postings.length, 0);
});

test("parseCvvizPage throws on a wrong-shaped envelope (field drift)", () => {
  assert.throws(() => parseCvvizPage(company, "stackby", asJson({ jobs: [] })), /schema/i);
});

test("listPostings pages the slug-keyed endpoint to the reported total", async (t) => {
  const urls: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ ...rawJob, id: i + 1 }));
  const pages = [
    { data: firstPage, meta: { pagination: { page: 1, pageSize: 100, totalItems: 101, totalPages: 2 } } },
    { data: [{ ...rawJob, id: 101 }], meta: { pagination: { page: 2, pageSize: 100, totalItems: 101, totalPages: 2 } } },
  ];
  const seq = fetchSequence(() => jsonResponse(at(pages, 0)), () => jsonResponse(at(pages, 1)));
  stubFetch(t, async (input, init) => {
    urls.push(String(input));
    return seq(input, init);
  });
  const postings = await cvvizAdapter.listPostings({ ...company, apiMeta: null });
  assert.equal(postings.length, 101);
  assert.equal(at(postings, 100).externalId, "101");
  assert.deepEqual(urls, [
    "https://api.cvviz.com/public/career-pages/stackby/jobs?context=employer&page=1&pageSize=100",
    "https://api.cvviz.com/public/career-pages/stackby/jobs?context=employer&page=2&pageSize=100",
  ]);
});

test("listPostings rejects when the endpoint serves the SPA HTML instead of JSON", async (t) => {
  stubFetch(t, fetchSequence(() => new Response("<!DOCTYPE html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } })));
  await assert.rejects(cvvizAdapter.listPostings(company));
});
