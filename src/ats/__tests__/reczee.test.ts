import { test } from "node:test";
import assert from "node:assert/strict";
import { reczeeAdapter, reczeeListUrl } from "../reczee.js";
import type { AdapterCompany } from "../../types.js";
import { rejectionOf } from "../../__tests__/caught.js";
import { at, fetchSequence, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

function company(overrides: Partial<AdapterCompany> = {}): AdapterCompany {
  return mkAdapterCompany(
    { provider: "reczee", slug: "unosecur", name: "Unosecur", careersUrl: "https://jobs.reczee.com/unosecur" },
    overrides,
  );
}

function requisition(id: number, overrides: object = {}) {
  return {
    id,
    company: { id: 2284, approved: true, name: "Unosecur", website: null },
    company_id: 2284,
    department: { id: 4141, title: "Engineering", company_id: 2284 },
    designation: "Software Development Engineer II",
    experience_range: [3, 5],
    job_description: "<h3>About the Role</h3><p>Build the <strong>UI</strong>.</p>",
    job_type: "full_time",
    job_type_display: "Full-time",
    locations: [{ id: 3, city: "Bengaluru", country: "India", country_code: "IN" }],
    open_for_careers_page: true,
    posted_on: "2026-10-06T10:44:34.000Z",
    slug: "4N3HO",
    title: "UI Developer",
    ...overrides,
  };
}

test("reczeeListUrl queries by company slug", () => {
  assert.equal(
    reczeeListUrl(company()),
    "https://app.reczee.com/api/v1/requisitions/get-open-requisitions?company_slug=unosecur",
  );
});

test("listPostings normalizes requisitions with inline JD and the public apply URL", async (t) => {
  const remote = requisition(2, {
    slug: "QrF01",
    title: "Solution Engineer",
    locations: [
      { id: 9, city: "Remote", country: null, country_code: null },
      { id: 3, city: "Bengaluru", country: "India", country_code: "IN" },
    ],
  });
  stubFetch(t, fetchSequence(() => jsonResponse({ data: { requisitions: [requisition(1), remote], company: "Unosecur" } })));
  const postings = await reczeeAdapter.listPostings(company());
  assert.equal(postings.length, 2);
  const p = at(postings, 0);
  assert.equal(p.provider, "reczee");
  assert.equal(p.externalId, "1");
  assert.equal(p.jobTitle, "UI Developer");
  assert.equal(p.jobUrl, "https://jobs.reczee.com/unosecur/4N3HO/apply");
  assert.equal(p.location, "Bengaluru, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, "2026-10-06T10:44:34.000Z");
  assert.match(p.jdText, /About the Role[\s\S]*Build the UI\./);
  const r = at(postings, 1);
  assert.equal(r.location, "Remote; Bengaluru, India");
  assert.equal(r.isRemote, true);
});

test("listPostings returns nothing for a live tenant with no openings", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ data: { requisitions: [], company: "RDash" } })));
  assert.deepEqual(await reczeeAdapter.listPostings(company({ slug: "rdash" })), []);
});

test("listPostings throws on an unknown tenant (404 Invalid URL)", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ error_messages: "Invalid URL" }, 404)));
  assert.ok(await rejectionOf(reczeeAdapter.listPostings(company({ slug: "nope" }))));
});

test("listPostings falls back to designation and tolerates missing locations", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ data: { requisitions: [requisition(5, { title: null, locations: [] })] } })));
  const p = at(await reczeeAdapter.listPostings(company()), 0);
  assert.equal(p.jobTitle, "Software Development Engineer II");
  assert.equal(p.location, null);
});
