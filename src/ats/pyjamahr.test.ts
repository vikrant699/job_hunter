// src/ats/pyjamahr.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPyjamahrTenantExists,
  pyjamahrAdapter,
  pyjamahrBoardPageUrl,
  pyjamahrCompanyUuid,
  pyjamahrListUrl,
  pyjamahrJdUrl,
  pyjamahrBoardParam,
  pyjamahrJobUrl,
  pyjamahrLocation,
  pyjamahrTenantVerdict,
  parsePyjamahrList,
  parsePyjamahrDetail,
  normalizePyjamahr,
  PyjamahrJobSchema,
} from "./pyjamahr.js";
import type { PyjamahrJob } from "./pyjamahr.js";
import type { AdapterCompany } from "../types.js";
import { at, fetchSequence, htmlResponse, jsonResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";

const company: AdapterCompany = {
  provider: "pyjamahr",
  slug: "smallcase",
  name: "smallcase",
  careersUrl: "https://app.pyjamahr.com/careers?company=smallcase&company_uuid=2615584222",
  tenantUrl: null,
  apiMeta: { companyUuid: "2615584222" },
};

// Trimmed real item from GET api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222
// (captured 2026-07-11).
const job: PyjamahrJob = {
  id: 375341,
  slug: "manager-senior-manager-finance",
  title: "Manager/Senior Manager- Finance",
  max_experience: 7.0,
  min_experience: 3.0,
  country: "India",
  location: "Bengaluru, Karnataka, India",
  other_locations: [],
  department_name: "Finance",
  workplace_type: "HYBRID",
};

const listResponse = {
  count: 23,
  next: "https://api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222&is_careers_page=true&page=2",
  previous: null,
  results: [job],
};

// Trimmed real detail from GET api.pyjamahr.com/api/career/jobs/375341/?company_uuid=2615584222
const detailResponse = {
  id: 375341,
  uuid: "501D96BC0F",
  title: "Manager/Senior Manager- Finance",
  job_type: "FULLTIME",
  description:
    "<p><strong>About the team</strong></p>\n<p>The Finance team at CASE Platforms acts as a steward for the organisation.</p>",
};

test("pyjamahrCompanyUuid reads apiMeta.companyUuid and throws when missing", () => {
  assert.equal(pyjamahrCompanyUuid(company), "2615584222");
  assert.throws(() => pyjamahrCompanyUuid({ ...company, apiMeta: null }), /companyUuid/);
  assert.throws(() => pyjamahrCompanyUuid({ ...company, apiMeta: {} }), /companyUuid/);
});

test("pyjamahrListUrl / pyjamahrJdUrl build the public API URLs", () => {
  assert.equal(
    pyjamahrListUrl("2615584222", 1),
    "https://api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222&page=1&is_careers_page=true",
  );
  assert.equal(
    pyjamahrJdUrl("2615584222", "375341"),
    "https://api.pyjamahr.com/api/career/jobs/375341/?company_uuid=2615584222",
  );
});

test("pyjamahrBoardParam prefers the careersUrl ?company= param, falls back to slug", () => {
  assert.equal(pyjamahrBoardParam(company), "smallcase");
  assert.equal(pyjamahrBoardParam({ ...company, careersUrl: "https://example.com/careers" }), "smallcase");
});

test("pyjamahrJobUrl deep-links the board SPA by job slug (id fallback)", () => {
  assert.equal(
    pyjamahrJobUrl(company, job),
    "https://app.pyjamahr.com/careers/manager-senior-manager-finance?company=smallcase&company_uuid=2615584222",
  );
  assert.equal(
    pyjamahrJobUrl(company, { ...job, slug: null }),
    "https://app.pyjamahr.com/careers/375341?company=smallcase&company_uuid=2615584222",
  );
});

test("pyjamahrLocation combines location + other_locations + country without duplicates", () => {
  assert.equal(pyjamahrLocation(job), "Bengaluru, Karnataka, India");
  assert.equal(
    pyjamahrLocation({ ...job, other_locations: ["Mumbai, Maharashtra, India"] }),
    "Bengaluru, Karnataka, India; Mumbai, Maharashtra, India",
  );
  // country appended only when no other part already mentions it
  assert.equal(pyjamahrLocation({ ...job, location: "Bengaluru" }), "Bengaluru; India");
  assert.equal(pyjamahrLocation({ ...job, location: null, other_locations: [], country: null }), null);
});

test("parsePyjamahrList unwraps the DRF envelope", () => {
  const page = parsePyjamahrList(listResponse);
  assert.equal(page.count, 23);
  assert.equal(page.next, listResponse.next);
  assert.equal(page.results.length, 1);
  assert.equal(at(page.results, 0).title, "Manager/Senior Manager- Finance");
});

test("PyjamahrJobSchema tolerates missing optionals, rejects missing id/title", () => {
  assert.ok(PyjamahrJobSchema.safeParse({ id: 1, title: "x" }).success);
  assert.equal(PyjamahrJobSchema.safeParse({ title: "no id" }).success, false);
  assert.equal(PyjamahrJobSchema.safeParse({ id: 1 }).success, false);
});

test("parsePyjamahrDetail pulls the HTML description", () => {
  assert.match(parsePyjamahrDetail(detailResponse) ?? "", /About the team/);
  assert.equal(parsePyjamahrDetail({ id: 1 }), null);
});

test("normalizePyjamahr maps fields; jdText stays empty (fetchJd fills it)", () => {
  const p = normalizePyjamahr(company, job);
  assert.equal(p.provider, "pyjamahr");
  assert.equal(p.externalId, "375341");
  assert.equal(p.companySlug, "smallcase");
  assert.equal(p.jobTitle, "Manager/Senior Manager- Finance");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
  assert.equal(
    p.jobUrl,
    "https://app.pyjamahr.com/careers/manager-senior-manager-finance?company=smallcase&company_uuid=2615584222",
  );
});

test("normalizePyjamahr flags REMOTE workplace_type", () => {
  const p = normalizePyjamahr(company, { ...job, workplace_type: "REMOTE", location: "India" });
  assert.equal(p.isRemote, true);
});

// --- dead company_uuid vs genuinely empty board --------------------------------

// The exact body every bogus company_uuid returned when probed 2026-08-03
// (ZZZZZZZZZZ, 0000000000, acmewidgetsco, ""), and equally what a live tenant
// with nothing open returns: HTTP 200, count 0, no rows.
const emptyListResponse = { count: 0, next: null, previous: null, results: [] };

/** Board page HTML the way Next.js ships it: one __NEXT_DATA__ JSON island. */
function boardPage(pageProps: unknown): string {
  const island = {
    props: { pageProps, __N_SSP: true },
    page: "/careers",
    query: { company: "smallcase", company_uuid: "2615584222" },
    buildId: "oD55ru5AabMKcy2oaL_Gj",
    isFallback: false,
    gssp: true,
    scriptLoader: [],
  };
  return `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(island)}</script></body></html>`;
}

// Trimmed from GET app.pyjamahr.com/careers?company=neusort&company_uuid=4E65221EE7
// (captured 2026-08-03): the SSR resolved the uuid to a company.
const RESOLVES_HTML = boardPage({
  isBot: false,
  companyDetails: { id: 14442, name: "smallcase", slug: "smallcase", uuid: "2615584222" },
});

// Verbatim pageProps from GET app.pyjamahr.com/careers?company=zzz&company_uuid=ZZZZZZZZZZ
// (HTTP 200, captured 2026-08-03): the SSR's own tenant lookup 404ed.
const ABSENT_HTML = boardPage({ error: "Request failed with status code 404" });

test("pyjamahrBoardPageUrl builds the board link with BOTH params (the SSR needs ?company= to run)", () => {
  assert.equal(
    pyjamahrBoardPageUrl(company, "2615584222"),
    "https://app.pyjamahr.com/careers?company=smallcase&company_uuid=2615584222",
  );
  // bynry's row has no ?company= in careers_url, so the slug fills in — and that
  // is what the vendor resolved when probed.
  const bynry: AdapterCompany = {
    provider: "pyjamahr",
    slug: "bynry",
    name: "Bynry",
    careersUrl: "https://jobs.pyjamahr.com/bynry",
    tenantUrl: "https://app.pyjamahr.com",
    apiMeta: { companyUuid: "1A8D01785C" },
  };
  assert.equal(
    pyjamahrBoardPageUrl(bynry, "1A8D01785C"),
    "https://app.pyjamahr.com/careers?company=bynry&company_uuid=1A8D01785C",
  );
  // Kuku FM's ?company= value has a space; it must stay percent-encoded.
  const kukufm: AdapterCompany = {
    ...company,
    slug: "kukufm",
    careersUrl: "https://app.pyjamahr.com/careers?company=Kuku%20FM&company_uuid=8B92017E1E",
    apiMeta: { companyUuid: "8B92017E1E" },
  };
  assert.equal(
    pyjamahrBoardPageUrl(kukufm, "8B92017E1E"),
    "https://app.pyjamahr.com/careers?company=Kuku%20FM&company_uuid=8B92017E1E",
  );
});

test("pyjamahrTenantVerdict reads the board page's SSR props", () => {
  assert.equal(pyjamahrTenantVerdict(RESOLVES_HTML), "resolves");
  assert.equal(pyjamahrTenantVerdict(ABSENT_HTML), "absent");
});

test("pyjamahrTenantVerdict is inconclusive for anything it does not recognise", () => {
  // None of these is evidence about the tenant, so none may fail the company.
  assert.equal(pyjamahrTenantVerdict("<html><body>no island here</body></html>"), "inconclusive");
  assert.equal(
    pyjamahrTenantVerdict(`<script id="__NEXT_DATA__" type="application/json">{not json</script>`),
    "inconclusive",
  );
  assert.equal(pyjamahrTenantVerdict(boardPage({ isBot: false })), "inconclusive");
  assert.equal(pyjamahrTenantVerdict(boardPage({ statusCode: 500 })), "inconclusive");
});

test("assertPyjamahrTenantExists throws only for the definitive absent verdict", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(ABSENT_HTML)));
  await assert.rejects(
    () => assertPyjamahrTenantExists(company, "2615584222"),
    /pyjamahr: tenant does not exist.*2615584222.*smallcase/s,
  );
});

test("the dead-uuid error is charged to the company, not written off as infrastructure", async (t) => {
  // A company_uuid the vendor does not know is a per-company board defect and
  // MUST count toward the row's consecutive_failures. If any of these flipped
  // true the scheduler would retry the board forever and never quarantine it.
  stubFetch(t, fetchSequence(() => htmlResponse(ABSENT_HTML)));
  const err = await assertPyjamahrTenantExists(company, "2615584222").then(
    () => new Error("expected the call to reject, but it resolved"),
    (e: unknown) => e,
  );
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("assertPyjamahrTenantExists stays silent when the tenant resolves", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(RESOLVES_HTML)));
  await assert.doesNotReject(() => assertPyjamahrTenantExists(company, "2615584222"));
});

test("assertPyjamahrTenantExists swallows a failure of its OWN probe", async (t) => {
  // The list call already succeeded; an outage or a 500 on the confirmation
  // request is evidence about the probe, not about the tenant.
  stubFetch(t, () => Promise.reject(new Error("fetch failed")));
  await assert.doesNotReject(() => assertPyjamahrTenantExists(company, "2615584222"));

  stubFetch(t, fetchSequence(() => htmlResponse("upstream is unhappy", 503)));
  await assert.doesNotReject(() => assertPyjamahrTenantExists(company, "2615584222"));
});

test("pyjamahrAdapter.listPostings rejects a company_uuid the vendor does not know", async (t) => {
  stubFetch(t, fetchSequence(
    () => jsonResponse(emptyListResponse),
    () => htmlResponse(ABSENT_HTML),
  ));
  await assert.rejects(() => pyjamahrAdapter.listPostings(company), /pyjamahr: tenant does not exist/);
});

test("pyjamahrAdapter.listPostings returns [] for a LIVE tenant whose board has no open roles", async (t) => {
  // The distinction the check exists for: identical list response, but the uuid
  // resolves, so nothing fails.
  stubFetch(t, fetchSequence(
    () => jsonResponse(emptyListResponse),
    () => htmlResponse(RESOLVES_HTML),
  ));
  assert.deepEqual(await pyjamahrAdapter.listPostings(company), []);
});

test("pyjamahrAdapter.listPostings never spends the extra request on a board that produced rows", async (t) => {
  // fetchSequence rejects any call past the ones given, so a second fetch here
  // would fail the test outright.
  stubFetch(t, fetchSequence(() => jsonResponse({ ...listResponse, next: null })));
  const postings = await pyjamahrAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(at(postings, 0).externalId, "375341");
});
