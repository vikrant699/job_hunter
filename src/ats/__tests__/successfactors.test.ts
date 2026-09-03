import { test } from "node:test";
import * as cheerio from "cheerio";
import assert from "node:assert/strict";
import {
  successfactorsSearchUrl,
  isSuccessfactorsEngine,
  parseSuccessfactorsTotal,
  parseJobHref,
  parseSuccessfactorsSearch,
  parseSuccessfactorsJd,
  successfactorsAdapter,
  tileLocation,
} from "../successfactors.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";
import type { AdapterCompany } from "../../types.js";
import { at, CHALLENGE_PAGE_HTML, htmlResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "successfactors",
  slug: "heromotocorp",
  name: "Hero MotoCorp",
  careersUrl: "https://jobs.heromotocorp.com/search/",
  tenantUrl: null,
  apiMeta: null,
};

// Each row renders twice (desktop .hidden-phone + mobile .visible-phone); row 2 exercises a remote location.
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
  assert.equal(rowCount, 2); // drives pagination offset advancement
  assert.equal(postings.length, 2); // desktop/mobile duplicates collapse, not 4

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

// Page size is per-tenant, not per-engine; a hardcoded 25 used to truncate 10-row tenants at page 1.
const mahindra = mkAdapterCompany({
  provider: "successfactors",
  slug: "mahindra-group",
  name: "Mahindra Group",
  careersUrl: "https://jobs.mahindracareers.com/search/",
});

/** One /search/ page: `count` rows at `startrow`; banner omitted when `total` is null (tile-skin tenants). */
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

/** A sitemap.xml request the /search/ pagination tests don't care about: 404 it without recording an offset. */
function stubSitemap404(input: string): Response | null {
  if (input.includes("/sitemap.xml")) return htmlResponse("not found", 404);
  return null;
}

/** Serve a board of `total` jobs `perPage` rows at a time, recording offsets. */
function stubBoard(
  t: Parameters<typeof stubFetch>[0],
  opts: { total: number; perPage: number; banner?: boolean },
): number[] {
  const startrows: number[] = [];
  stubFetch(t, (input) => {
    const url = String(input);
    const sitemap = stubSitemap404(url);
    if (sitemap) return Promise.resolve(sitemap);
    const startrow = startrowOf(url);
    startrows.push(startrow);
    const count = Math.max(0, Math.min(opts.perPage, opts.total - startrow));
    return Promise.resolve(htmlResponse(searchPageHtml(startrow, count, opts.banner === false ? null : opts.total)));
  });
  return startrows;
}

test("listPostings: a 10-rows-per-page tenant is not truncated at page 1", async (t) => {
  // Pre-fix, this returned only the first 10 of 34.
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
  // Tile-skin tenants omit the banner, so only the short final page can end the loop.
  const startrows = stubBoard(t, { total: 14, perPage: 10, banner: false });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 14);
  assert.deepEqual(startrows, [0, 10]);
});

test("listPostings: a tenant that clamps an out-of-range startrow terminates", async (t) => {
  // Some tenants re-serve the last page instead of an empty one, with no banner to bound the loop.
  const startrows: number[] = [];
  stubFetch(t, (input) => {
    const url = String(input);
    const sitemap = stubSitemap404(url);
    if (sitemap) return Promise.resolve(sitemap);
    const startrow = startrowOf(url);
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
  stubFetch(t, (input) => {
    const sitemap = stubSitemap404(String(input));
    if (sitemap) return Promise.resolve(sitemap);
    calls++;
    return Promise.resolve(htmlResponse(searchPageHtml(0, 10, 608)));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);

  assert.equal(postings.length, 10);
  assert.equal(calls, 2, "must not paginate to the phantom total");
});

// A live Jobs2Web board with nothing open: no rows, no results banner, just the engine's own #noresults block.
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

// A lapsed subdomain: HTTP 200, plausible page, none of the engine's assets - parses to zero rows just like the page above.
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
  // Must count toward consecutive_failures, or the scheduler retries forever instead of quarantining.
  stubFetch(t, () => Promise.resolve(htmlResponse(PARKED_HTML)));
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  const err = await successfactorsAdapter.listPostings(mahindra).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("a WAF challenge page is an edge refusal, NOT a dead custom domain", async (t) => {
  stubFetch(t, () => Promise.resolve(htmlResponse(CHALLENGE_PAGE_HTML)));
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  const err = await successfactorsAdapter.listPostings(mahindra).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.ok(isInfrastructureFault(err), "a blocked request must not be charged to the board");
  assert.doesNotMatch(err.message, /tenant does not exist/);
});

test("a board that produced rows is never failed for missing engine assets", async (t) => {
  // Proves the check cannot fire on any page that parsed rows.
  const startrows = stubBoard(t, { total: 12, perPage: 10 });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 12);
  assert.deepEqual(startrows, [0, 10]);
});

test("only page 1 is audited: a parked-looking page past the end just ends the crawl", async (t) => {
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(htmlResponse(calls === 1 ? searchPageHtml(0, 10, null) : PARKED_HTML));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 10, "page 1's postings are kept, not thrown away");
});

test("tileLocation: labeled customfield wins when the standard location block is absent (cipla shape)", () => {
  const $ = cheerio.load(`<li class="job-tile"><div class="section-field customfield2">
    <div class="section-label">Location</div><div id="job-1-customfield2-value">Fall River</div></div></li>`);
  assert.equal(tileLocation($, $("li.job-tile"), "SAP-Ariba-Techo-Functional"), "Fall River");
});

test("tileLocation: Country/Region fallback (renew shape), then slug city (icici shape)", () => {
  const $c = cheerio.load(`<li class="job-tile"><div class="section-field country">
    <div class="section-label">Country/Region</div><div id="job-2-country-value">IN</div></div></li>`);
  assert.equal(tileLocation($c, $c("li.job-tile"), "Sr-Manager"), "IN");
  const $e = cheerio.load(`<li class="job-tile"></li>`);
  assert.equal(tileLocation($e, $e("li.job-tile"), "NAVI-MUMBAI-Sr_-Manager"), "NAVI MUMBAI");
  assert.equal(tileLocation($e, $e("li.job-tile"), "lowercase-slug"), null);
});

test("listPostings gap-fills a sitemap id the HTML search missed, keeping parsed rows untouched", async (t) => {
  const SITEMAP_XML = `<urlset>
    <url><loc>https://jobs.mahindracareers.com/job/Role-0/0/</loc></url>
    <url><loc>https://jobs.mahindracareers.com/job/Role-1/1/</loc></url>
    <url><loc>https://jobs.mahindracareers.com/job/Sitemap-Only-Extra-Role/777/</loc></url>
  </urlset>`;
  stubFetch(t, (input) => {
    const url = String(input);
    if (url.includes("/sitemap.xml")) return Promise.resolve(htmlResponse(SITEMAP_XML));
    const startrow = startrowOf(url);
    // A 2-job board that ends on its first (short) page.
    return Promise.resolve(htmlResponse(searchPageHtml(startrow, startrow === 0 ? 2 : 0, 2)));
  });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 3);
  const extra = postings.find((p) => p.externalId === "777");
  assert.ok(extra);
  assert.equal(extra.jobUrl, "https://jobs.mahindracareers.com/job/Sitemap-Only-Extra-Role/777/");
  assert.equal(extra.jobTitle, "Sitemap Only Extra Role");
  assert.equal(extra.location, null);
  assert.equal(extra.jdText, "");
  // The rows the HTML search already parsed are untouched.
  assert.deepEqual(postings.filter((p) => p.externalId !== "777").map((p) => p.externalId).sort(), ["0", "1"]);
});

test("listPostings: a sitemap fetch failure leaves the HTML-only result unchanged", async (t) => {
  const startrows = stubBoard(t, { total: 12, perPage: 10 });
  const postings = await successfactorsAdapter.listPostings(mahindra);
  assert.equal(postings.length, 12);
  assert.deepEqual(startrows, [0, 10]);
});
