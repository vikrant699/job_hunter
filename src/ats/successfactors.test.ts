// src/ats/successfactors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  successfactorsSearchUrl,
  isSuccessfactorsEngine,
  parseSuccessfactorsTotal,
  parseJobHref,
  parseSuccessfactorsSearch,
  parseSuccessfactorsJd,
  successfactorsAdapter,
} from "./successfactors.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../util/error-cause.js";
import type { AdapterCompany } from "../types.js";
import { at, htmlResponse, mkAdapterCompany, stubFetch } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "successfactors",
  slug: "heromotocorp",
  name: "Hero MotoCorp",
  careersUrl: "https://jobs.heromotocorp.com/search/",
  tenantUrl: null,
  apiMeta: null,
};

// A 2-row search page. Each row renders twice (desktop .hidden-phone +
// mobile .visible-phone), fields selected by class WITHIN the row. Row 1
// mirrors Hero (title column first); row 2 exercises a remote location.
const SEARCH_HTML = `
<html><body>
  <span class="paginationLabel" aria-label="Results 1 – 25">Results 1 to 25 of 46</span>
  <table class="searchResults full table">
    <tbody>
      <tr class="data-row">
        <td class="colTitle" headers="hdrTitle">
          <span class="jobTitle hidden-phone">
            <a href="/job/Chittoor-Team-Manager-Weld-Shop-AP/1332433066/" class="jobTitle-link">Team Manager - Weld Shop</a>
          </span>
          <div class="jobdetail-phone visible-phone">
            <span class="jobTitle visible-phone">
              <a class="jobTitle-link" href="/job/Chittoor-Team-Manager-Weld-Shop-AP/1332433066/">Team Manager - Weld Shop</a>
            </span>
            <span class="jobLocation visible-phone"><span class="jobLocation">Chittoor, AP, IN</span></span>
            <span class="jobDate visible-phone">10 Jul 2026</span>
          </div>
        </td>
        <td class="colDepartment hidden-phone"><span class="jobDepartment">PLANT OPERATIONS</span></td>
        <td class="colLocation hidden-phone"><span class="jobLocation">Chittoor, AP, IN</span></td>
        <td class="colDate hidden-phone"><span class="jobDate">10 Jul 2026</span></td>
      </tr>
      <tr class="data-row">
        <td class="colTitle" headers="hdrTitle">
          <span class="jobTitle hidden-phone">
            <a href="/job/Remote-Frontend-Engineer/998877/" class="jobTitle-link">Frontend Engineer</a>
          </span>
        </td>
        <td class="colDepartment hidden-phone"><span class="jobDepartment">IT</span></td>
        <td class="colLocation hidden-phone"><span class="jobLocation">Remote - India</span></td>
        <td class="colDate hidden-phone"><span class="jobDate">Jul 09, 2026</span></td>
      </tr>
    </tbody>
  </table>
</body></html>`;

const JD_HTML = `
<html><body>
  <span class="jobdescription"><div><H2><b>Function</b></H2><p>Operations</p></div>
  <ul><li>Own the weld shop</li><li>Lead the team</li></ul></span>
</body></html>`;

test("successfactorsSearchUrl builds the paged /search/ URL at the row offset", () => {
  assert.equal(
    successfactorsSearchUrl("https://jobs.heromotocorp.com", 50),
    "https://jobs.heromotocorp.com/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=50",
  );
});

test("parseSuccessfactorsTotal reads the 'Results X to Y of N' banner", () => {
  assert.equal(parseSuccessfactorsTotal(SEARCH_HTML), 46);
  assert.equal(parseSuccessfactorsTotal('<p>Results 1 to 25 of 1,234</p>'), 1234);
  assert.equal(parseSuccessfactorsTotal("<p>no banner here</p>"), null);
});

test("parseJobHref splits /job/<slug>/<reqId>/ and rejects other shapes", () => {
  assert.deepEqual(parseJobHref("/job/Chittoor-Team-Manager-Weld-Shop-AP/1332433066/"), {
    slug: "Chittoor-Team-Manager-Weld-Shop-AP",
    reqId: "1332433066",
  });
  assert.deepEqual(parseJobHref("/job/slug/42/?lang=en"), { slug: "slug", reqId: "42" });
  assert.equal(parseJobHref("/search/?q=foo"), null);
  assert.equal(parseJobHref("/job/"), null);
});

test("parseJobHref matches brand-prefixed /job/ paths (multi-brand tenants)", () => {
  assert.deepEqual(parseJobHref("/TaroPharma/job/Hawthorne-Line-Mechanic-Temporary-QC/6196744/"), {
    slug: "Hawthorne-Line-Mechanic-Temporary-QC",
    reqId: "6196744",
  });
  assert.deepEqual(parseJobHref("/SomeBrand/job/foo-bar/12345/"), { slug: "foo-bar", reqId: "12345" });
});

test("parseSuccessfactorsSearch parses rows once each, mapping title/location/date/id", () => {
  const { postings, rowCount, total } = parseSuccessfactorsSearch(SEARCH_HTML, company);
  assert.equal(total, 46);
  assert.equal(rowCount, 2); // one <tr.data-row> per job — drives offset advancement
  assert.equal(postings.length, 2); // NOT 4 — the phone/desktop duplicates collapse

  const first = at(postings, 0);
  assert.equal(first.provider, "successfactors");
  assert.equal(first.externalId, "1332433066");
  assert.equal(first.companySlug, "heromotocorp");
  assert.equal(first.jobTitle, "Team Manager - Weld Shop");
  assert.equal(first.jobUrl, "https://jobs.heromotocorp.com/job/Chittoor-Team-Manager-Weld-Shop-AP/1332433066/");
  assert.equal(first.location, "Chittoor, AP, IN");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, ""); // JD populated by fetchJd, not the listing
  assert.equal(first.postedAt, new Date("10 Jul 2026").toISOString());

  const second = at(postings, 1);
  assert.equal(second.externalId, "998877");
  assert.equal(second.location, "Remote - India");
  assert.equal(second.isRemote, true);
  assert.equal(second.postedAt, new Date("Jul 09, 2026").toISOString());
});

test("rowCount counts every data-row; brand-prefixed rows are kept, only non-job rows drop", () => {
  const html = `<table><tbody>
    <tr class="data-row"><td class="colTitle">
      <a href="/job/good-role/111/" class="jobTitle-link">Good Role</a>
      <span class="jobLocation">Pune, IN</span></td></tr>
    <tr class="data-row"><td class="colTitle">
      <a href="/SomeBrand/job/foo-bar/12345/" class="jobTitle-link">Brand Role</a>
      <span class="jobLocation">Mumbai, IN</span></td></tr>
    <tr class="data-row"><td class="colTitle">
      <a href="/not-a-job/xyz" class="jobTitle-link">Ad Row</a></td></tr>
  </tbody></table>`;
  const { postings, rowCount } = parseSuccessfactorsSearch(html, company);
  assert.equal(rowCount, 3);      // all rows counted for pagination offset
  assert.equal(postings.length, 2); // root-path AND brand-prefixed /job/ rows kept; ad row dropped
  assert.equal(at(postings, 0).externalId, "111");
  // Brand-prefixed subsidiary posting must NOT be silently dropped.
  assert.equal(at(postings, 1).externalId, "12345");
  assert.equal(at(postings, 1).jobUrl, "https://jobs.heromotocorp.com/SomeBrand/job/foo-bar/12345/");
});

test("parseSuccessfactorsJd extracts and strips the jobdescription HTML", () => {
  const jd = parseSuccessfactorsJd(JD_HTML);
  assert.match(jd, /Function/);
  assert.match(jd, /Own the weld shop/);
  assert.match(jd, /Lead the team/);
  assert.doesNotMatch(jd, /<li>|<div>|<H2>/i);
});

test("empty page: no rows and no banner yields zero postings and null total", () => {
  const { postings, total } = parseSuccessfactorsSearch(
    "<html><body><table class='searchResults'></table></body></html>",
    company,
  );
  assert.equal(postings.length, 0);
  assert.equal(total, null);
});

test("malformed page: garbage HTML yields zero postings, no throw", () => {
  const { postings, total } = parseSuccessfactorsSearch("<not-real><<>garbage", company);
  assert.equal(postings.length, 0);
  assert.equal(total, null);
});

test("parseSuccessfactorsJd returns empty string when the span is absent", () => {
  assert.equal(parseSuccessfactorsJd("<html><body><p>nothing</p></body></html>"), "");
});

test("parseSuccessfactorsSearch falls back to tile-view cards when no table rows exist", () => {
  const tileHtml = `<html><body><ul>
    <li class="job-tile job-id-56793244" data-url="/job/Mumbai-Deputy-Buyer-Kids-wear-Maha/56793244/" data-row-index="1">
      <span class="section-title title">
        <a class="jobTitle-link" href="/job/Mumbai-Deputy-Buyer-Kids-wear-Maha/56793244/"> Deputy Buyer - Kids wear </a>
      </span>
      <div class="section-field location">
        <span class="section-label"> Location </span>
        <div id="job-56793244-desktop-section-location-value">Mumbai, Maharashtra, India </div>
      </div>
    </li>
  </ul></body></html>`;
  const { postings, rowCount } = parseSuccessfactorsSearch(tileHtml, company);
  assert.equal(rowCount, 1);
  assert.equal(postings.length, 1);
  assert.equal(at(postings, 0).externalId, "56793244");
  assert.equal(at(postings, 0).jobTitle, "Deputy Buyer - Kids wear");
  assert.equal(at(postings, 0).location, "Mumbai, Maharashtra, India");
  assert.match(at(postings, 0).jobUrl, /careers\.example\.com|\/job\/Mumbai-Deputy-Buyer-Kids-wear-Maha\/56793244\//);
});

// --- listPostings pagination (full flow, mocked fetch) ---------------------
//
// The engine's page size is per-TENANT, not per-engine: jobs.mahindracareers.com
// serves 10 rows per /search/ page while jobs.heromotocorp.com serves 25. The
// adapter used to declare a fixed 25 to paginate(), so a 10-row tenant's very
// first page looked "short" and the board stopped at 10 of 608 postings.

const mahindra = mkAdapterCompany({
  provider: "successfactors",
  slug: "mahindra-group",
  name: "Mahindra Group",
  careersUrl: "https://jobs.mahindracareers.com/search/",
});

/** One /search/ page: `count` rows starting at `startrow`, plus the results
 *  banner unless `total` is null (tenants on the tile skin omit it). */
function searchPageHtml(startrow: number, count: number, total: number | null): string {
  const banner =
    total === null
      ? ""
      : `<span class="paginationLabel">Results ${startrow + 1} to ${startrow + count} of ${total}</span>`;
  const rows = Array.from({ length: count }, (_, i) => {
    const id = startrow + i;
    return `<tr class="data-row">
      <td class="colTitle"><span class="jobTitle hidden-phone">
        <a href="/job/Role-${id}/${id}/" class="jobTitle-link">Role ${id}</a></span></td>
      <td class="colLocation hidden-phone"><span class="jobLocation">Mumbai, MH, IN</span></td>
      <td class="colDate hidden-phone"><span class="jobDate">10 Jul 2026</span></td>
    </tr>`;
  }).join("");
  return `<html><body>${banner}<table class="searchResults"><tbody>${rows}</tbody></table></body></html>`;
}

function startrowOf(input: string): number {
  return Number(new URL(input).searchParams.get("startrow"));
}

/** Serve a board of `total` jobs `perPage` rows at a time, recording offsets. */
function stubBoard(
  t: Parameters<typeof stubFetch>[0],
  opts: { total: number; perPage: number; banner?: boolean },
): number[] {
  const startrows: number[] = [];
  stubFetch(t, (input) => {
    const startrow = startrowOf(String(input));
    startrows.push(startrow);
    const count = Math.max(0, Math.min(opts.perPage, opts.total - startrow));
    return Promise.resolve(htmlResponse(searchPageHtml(startrow, count, opts.banner === false ? null : opts.total)));
  });
  return startrows;
}

test("listPostings: a 10-rows-per-page tenant is not truncated at page 1", async (t) => {
  // The mahindra-group failure mode, scaled down: 34 jobs at 10 rows a page.
  // Pre-fix this returned only the first 10.
  const startrows = stubBoard(t, { total: 34, perPage: 10 });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 34, "every posting on the board must be collected");
  assert.deepEqual(startrows, [0, 10, 20, 30], "offsets advance by the server's own row count");
  assert.equal(at(postings, 0).externalId, "0");
  assert.equal(at(postings, 33).externalId, "33");
});

test("listPostings: a 25-rows-per-page tenant still paginates exactly as before", async (t) => {
  const startrows = stubBoard(t, { total: 30, perPage: 25 });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 30);
  assert.deepEqual(startrows, [0, 25], "the short final page ends the loop, no out-of-range fetch");
});

test("listPostings: a board with no results banner stops on its genuinely short final page", async (t) => {
  // Tile-skin tenants omit "Results X to Y of N", so nothing but the short page
  // can end the loop - it must still stop, and only after the last page.
  const startrows = stubBoard(t, { total: 14, perPage: 10, banner: false });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 14);
  assert.deepEqual(startrows, [0, 10]);
});

test("listPostings: a tenant that clamps an out-of-range startrow terminates", async (t) => {
  // careers.acer.com re-serves the last page instead of an empty one, and has
  // no banner to bound the loop: the all-duplicate page must end it.
  const startrows: number[] = [];
  stubFetch(t, (input) => {
    const startrow = startrowOf(String(input));
    startrows.push(startrow);
    // 20 jobs, 10 a page; anything past row 10 is clamped back to the last page.
    const clamped = Math.min(startrow, 10);
    return Promise.resolve(htmlResponse(searchPageHtml(clamped, 10, null)));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 20, "both real pages kept");
  assert.deepEqual(startrows, [0, 10, 20], "one clamped page detected, then stop");
});

test("listPostings: a board that ignores startrow entirely stops after the repeat page", async (t) => {
  // A stated total of 608 with a frozen first page must not walk 61 pages.
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(htmlResponse(searchPageHtml(0, 10, 608)));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 10);
  assert.equal(calls, 2, "must not paginate to the phantom total");
});

// --- dead custom domain vs empty board ----------------------------------------
//
// These tenants sit on the company's OWN domain, so the failure to catch is the
// domain quietly ceasing to serve SuccessFactors while still answering 200.
// Shapes below come from live probes on 2026-08-02.

// Trimmed from GET careers.tatapower.com/search/?…&startrow=0 (HTTP 200). A
// LIVE Jobs2Web board with nothing open: no tr.data-row, no li.job-tile and no
// "Results N to M of TOTAL" banner — the engine renders its own #noresults
// block instead. careers.mankindpharma.com serves the same shape, and so does
// any healthy tenant searched for a nonsense keyword. Failing this would
// quarantine two live boards, so it is the case that matters most here.
const EMPTY_ENGINE_HTML = `<!DOCTYPE html>
<html lang="en-GB">
  <head>
    <title>tatapower Jobs</title>
    <link type="text/css" class="keepscript" rel="stylesheet" href="https://careers.tatapower.com/platform/bootstrap/3.4.8_NES/css/bootstrap.min.css" />
    <link type="text/css" rel="stylesheet" href="/platform/css/j2w/min/bootstrapV3.global.responsive.min.css?h=b942c10c" />
    <script src="/platform/js/j2w/j2w.fallbacks.js"></script>
  </head>
  <body>
    <div id="content">
      <h1 class="keyword-title">Search results for<span class="securitySearchQuery"> "".</span></h1>
      <div id="noresults" xml:lang="en-GB" lang="en-GB" class="alert alert-block">
        <div id="attention">
          <img id="attention-img" src="/platform/images/attention.png" alt="Attention!" border="0" />
          <label>There are currently no open positions matching "<span class='attention securitySearchString'></span>".</label>
        </div>
        <div id="noresults-message"><label>The 0 most recent jobs posted by tatapower are listed below for your convenience.</label></div>
      </div>
      <div class="jobAlertsSearchForm"></div>
    </div>
  </body>
</html>
`;

// What a lapsed careers subdomain serves once it stops pointing at Jobs2Web:
// still HTTP 200, still plausible, but none of the engine's assets. Parses to
// zero rows exactly like the page above, which is why size or row count cannot
// tell them apart.
const PARKED_HTML = `<!DOCTYPE html>
<html>
  <head><title>careers.example.com</title></head>
  <body>
    <div id="content">
      <h1>careers.example.com</h1>
      <p>This domain is parked. Enquiries welcome.</p>
    </div>
  </body>
</html>
`;

test("isSuccessfactorsEngine recognises the Jobs2Web asset namespace, empty board or not", () => {
  assert.equal(isSuccessfactorsEngine(EMPTY_ENGINE_HTML), true);
  assert.equal(isSuccessfactorsEngine(SEARCH_HTML.replace("<html>", '<html><script src="/platform/js/j2w/x.js"></script>')), true);
  assert.equal(isSuccessfactorsEngine(PARKED_HTML), false);
});

test("listPostings returns [] for a LIVE board rendering the engine's no-open-positions page", async (t) => {
  // tata-power and mankind-pharma are both in exactly this state right now.
  stubFetch(t, () => Promise.resolve(htmlResponse(EMPTY_ENGINE_HTML)));
  assert.deepEqual(await successfactorsAdapter.listPostings(mahindra), []);
});

test("listPostings rejects a custom domain that no longer serves the engine", async (t) => {
  stubFetch(t, () => Promise.resolve(htmlResponse(PARKED_HTML)));
  await assert.rejects(
    () => successfactorsAdapter.listPostings(mahindra),
    /successfactors: tenant does not exist/,
  );
});

test("the dead-domain error is charged to the company, not written off as infrastructure", async (t) => {
  // A domain that stopped serving the board is a real per-company defect and
  // MUST count toward consecutive_failures. If any of these flipped true the
  // scheduler would retry it forever and never quarantine it.
  stubFetch(t, () => Promise.resolve(htmlResponse(PARKED_HTML)));
  const err = await successfactorsAdapter.listPostings(mahindra).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("a board that produced rows is never failed for missing engine assets", async (t) => {
  // searchPageHtml carries no /platform/js/j2w/ at all, so this also proves the
  // check cannot fire on any page that parsed rows.
  const startrows = stubBoard(t, { total: 12, perPage: 10 });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 12);
  assert.deepEqual(startrows, [0, 10]);
});

test("only page 1 is audited: a parked-looking page past the end just ends the crawl", async (t) => {
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    // Page 1 is a real board; page 2 comes back as something else entirely.
    return Promise.resolve(htmlResponse(calls === 1 ? searchPageHtml(0, 10, null) : PARKED_HTML));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 10, "page 1's postings are kept, not thrown away");
});
