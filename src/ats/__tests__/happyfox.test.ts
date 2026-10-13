import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HAPPYFOX_ORIGIN,
  happyfoxAdapter,
  happyfoxListUrl,
  happyfoxOrigin,
  parseHappyfoxJd,
  parseHappyfoxList,
} from "../happyfox.js";
import { asJson, at, fetchSequence, htmlResponse, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company = mkAdapterCompany(
  { provider: "happyfox", slug: "happyfox", name: "HappyFox", careersUrl: "https://www.happyfox.com/jobs/" },
  { tenantUrl: "https://hiring.happyfox.co/" },
);

function job(id: number, location: string | null, workType = "in_person") {
  return {
    id,
    title: `Role ${id}`,
    slug: `role-${id}-${(location ?? "none").toLowerCase().replace(/\W+/g, "-")}`,
    department: "engineering",
    location: location === null ? null : { id: 7, name: location },
    work_type: workType,
    short_description: "Truncated teaser...",
  };
}

function listBody(jobs: ReturnType<typeof job>[], page: number, hasNext: boolean) {
  return {
    results: jobs,
    pagination: { page, page_size: 100, total_count: 999, total_pages: 9, has_next: hasNext, has_previous: page > 1 },
  };
}

const JD_HTML = `<!DOCTYPE html><html><body>
<main><div class="job-header"><h1 class="job-title">Sales Engineer</h1></div>
<div class="job-content"><div class="job-description">
  <div class="prose prose-wrapper"><p>As a <strong>Sales Engineer</strong> at HappyFox.</p>
  <p><strong>Responsibilities:</strong></p><ul><li>Build demos</li><li>Support customers</li></ul></div>
  <div class="job-actions"><button>Apply</button><button>Share Link</button></div>
</div></div></main>
<form id="application-form"><label>First name</label></form>
</body></html>`;

test("happyfoxOrigin prefers tenant_url, accepts a hiring.* careers_url, else the fixed board host", () => {
  assert.equal(happyfoxOrigin(company), "https://hiring.happyfox.co");
  assert.equal(happyfoxOrigin({ ...company, tenantUrl: null }), HAPPYFOX_ORIGIN);
  assert.equal(
    happyfoxOrigin({ ...company, tenantUrl: null, careersUrl: "https://hiring.happyfox.co/jobs/" }),
    "https://hiring.happyfox.co",
  );
  assert.equal(happyfoxOrigin({ ...company, tenantUrl: "not a url" }), HAPPYFOX_ORIGIN);
});

test("happyfoxListUrl is 1-based with an explicit page_size", () => {
  assert.equal(happyfoxListUrl(HAPPYFOX_ORIGIN, 2), "https://hiring.happyfox.co/api/jobs/?page=2&page_size=100");
});

test("parseHappyfoxList maps id, title, slug URL, location and remote flag", () => {
  const raw = asJson(listBody([job(14, "Bengaluru"), job(116, "Texas, United States"), job(9, null, "remote")], 1, false));
  const { postings, hasNext } = parseHappyfoxList(raw, company, "https://hiring.happyfox.co");
  assert.equal(hasNext, false);
  assert.equal(postings.length, 3);
  const blr = at(postings, 0);
  assert.equal(blr.provider, "happyfox");
  assert.equal(blr.externalId, "14");
  assert.equal(blr.jobTitle, "Role 14");
  assert.equal(blr.jobUrl, "https://hiring.happyfox.co/jobs/role-14-bengaluru/");
  assert.equal(blr.location, "Bengaluru");
  assert.equal(blr.isRemote, false);
  assert.equal(blr.jdText, "");
  assert.equal(blr.postedAt, null);
  assert.equal(at(postings, 1).location, "Texas, United States");
  assert.equal(at(postings, 2).location, null);
  assert.equal(at(postings, 2).isRemote, true);
});

test("parseHappyfoxList throws a schema error on a drifted payload", () => {
  assert.throws(() => parseHappyfoxList(asJson({ jobs: [] }), company, HAPPYFOX_ORIGIN), /schema/);
});

test("listPostings follows has_next across pages and stops without an extra fetch", async (t) => {
  const seen: string[] = [];
  const pages = [
    listBody([job(1, "Chennai"), job(2, "Chennai")], 1, true),
    listBody([job(3, "Hyderabad")], 2, true),
    listBody([job(4, "Dallas")], 3, false),
  ];
  stubFetch(t, (input) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("page") ?? "");
    const body = pages[Number(url.searchParams.get("page")) - 1];
    if (!body) return Promise.reject(new Error(`unexpected page ${url.search}`));
    return Promise.resolve(jsonResponse(body));
  });
  const items = await happyfoxAdapter.listPostings(company);
  assert.deepEqual(items.map((p) => p.externalId), ["1", "2", "3", "4"]);
  assert.deepEqual(seen, ["1", "2", "3"], "a short page 2 is not the end while has_next is true");
});

test("listPostings returns a single-page board in one fetch", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(listBody([job(1, "Bengaluru"), job(2, "Chennai")], 1, false))));
  const items = await happyfoxAdapter.listPostings(company);
  assert.equal(items.length, 2);
});

test("listPostings returns [] for an empty board", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse(listBody([], 1, false))));
  assert.deepEqual(await happyfoxAdapter.listPostings(company), []);
});

test("parseHappyfoxJd extracts the prose body, not the buttons or the apply form", () => {
  const jd = parseHappyfoxJd(JD_HTML);
  assert.match(jd, /Sales Engineer at HappyFox/);
  assert.match(jd, /Build demos/);
  assert.doesNotMatch(jd, /Share Link|First name|<p>/);
});

test("parseHappyfoxJd returns '' when the description block is missing", () => {
  assert.equal(parseHappyfoxJd("<html><body>Not found</body></html>"), "");
});

test("fetchJd fetches the posting's own page", async (t) => {
  const seen: string[] = [];
  stubFetch(t, (input) => {
    seen.push(String(input));
    return Promise.resolve(htmlResponse(JD_HTML));
  });
  const posting = at(parseHappyfoxList(asJson(listBody([job(5, "Chennai")], 1, false)), company, HAPPYFOX_ORIGIN).postings, 0);
  const jd = await happyfoxAdapter.fetchJd?.(company, posting);
  assert.match(jd ?? "", /Support customers/);
  assert.deepEqual(seen, ["https://hiring.happyfox.co/jobs/role-5-chennai/"]);
});
