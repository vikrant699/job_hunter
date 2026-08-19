import { test } from "node:test";
import assert from "node:assert/strict";
import { unberryAdapter, unberryCompanyId, unberryListUrl } from "../unberry.js";
import type { AdapterCompany } from "../../types.js";
import { at, fetchSequence, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

function company(overrides: Partial<AdapterCompany> = {}): AdapterCompany {
  return mkAdapterCompany(
    {
      provider: "unberry",
      slug: "vahan",
      name: "Vahan",
      careersUrl: "https://app.unberry.com/careers/68399df0f6eadf0013d0df16",
    },
    overrides,
  );
}

function listPage(jobs: object[], page: number, totalCount: number, hasNext: boolean) {
  return {
    success: true,
    statusCode: 200,
    row: [{ metadata: [{ totalCount, page, limit: 50, hasNext }], data: jobs }],
  };
}

const JOB_A = {
  _id: "job-a",
  jobTitle: "Senior Backend Engineer",
  jobLocationType: "on_site",
  jobFunction: "Engineering",
  publishedAt: "2026-08-01T00:00:00.000Z",
};
const JOB_B = {
  _id: "job-b",
  jobTitle: "CM- Chennai",
  jobLocationType: "remote",
  jobFunction: "Operations",
  publishedAt: "2026-08-02T00:00:00.000Z",
};

test("unberryCompanyId comes from the careers URL path, apiMeta overriding", () => {
  assert.equal(unberryCompanyId(company()), "68399df0f6eadf0013d0df16");
  assert.equal(unberryCompanyId(company({ apiMeta: { companyId: "override-id" } })), "override-id");
});

test("listPostings pages until hasNext=false and normalizes jobs", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      () => jsonResponse(listPage([JOB_A], 1, 2, true)),
      () => jsonResponse(listPage([JOB_B], 2, 2, false)),
    ),
  );
  const postings = await unberryAdapter.listPostings(company({ apiMeta: { fixedLocation: "India" } }));
  assert.equal(postings.length, 2);
  const a = at(postings, 0);
  assert.equal(a.provider, "unberry");
  assert.equal(a.externalId, "job-a");
  assert.equal(a.jobTitle, "Senior Backend Engineer");
  assert.equal(a.jobUrl, "https://app.unberry.com/careers/68399df0f6eadf0013d0df16/job-a");
  assert.equal(a.location, "India");
  assert.equal(a.isRemote, false);
  assert.equal(a.postedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(at(postings, 1).isRemote, true);
});

test("listPostings without fixedLocation leaves location null", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(listPage([JOB_A], 1, 1, false))));
  const postings = await unberryAdapter.listPostings(company());
  assert.equal(at(postings, 0).location, null);
});

test("fetchJd concatenates description, requirements, and benefits", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      () => jsonResponse(listPage([JOB_A], 1, 1, false)),
      () =>
        jsonResponse({
          success: true,
          statusCode: 200,
          data: {
            _id: "job-a",
            jobTitle: "Senior Backend Engineer",
            jobDescription: "<p>Build the marketplace.</p>",
            jobRequirements: "<ul><li>5+ years</li></ul>",
            jobBenefits: "<p>ESOPs.</p>",
          },
        }),
    ),
  );
  const postings = await unberryAdapter.listPostings(company());
  assert.ok(unberryAdapter.fetchJd);
  const jd = await unberryAdapter.fetchJd(company(), at(postings, 0));
  assert.match(jd, /Build the marketplace\./);
  assert.match(jd, /5\+ years/);
  assert.match(jd, /ESOPs\./);
});

test("a page with no metadata still terminates on the next empty page", async (t) => {
  stubFetch(
    t,
    fetchSequence(
      () => jsonResponse({ success: true, statusCode: 200, row: [{ metadata: [], data: [JOB_A] }] }),
      () => jsonResponse({ success: true, statusCode: 200, row: [{ metadata: [], data: [] }] }),
    ),
  );
  const postings = await unberryAdapter.listPostings(company());
  assert.equal(postings.length, 1);
});

test("unberryListUrl carries page and size", () => {
  assert.equal(
    unberryListUrl("abc", 2, 50),
    "https://ats-api.unberry.com/api/v3/job/abc?page=2&size=50",
  );
});
