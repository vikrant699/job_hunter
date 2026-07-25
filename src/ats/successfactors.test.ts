// src/ats/successfactors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  successfactorsSearchUrl,
  parseSuccessfactorsTotal,
  parseJobHref,
  parseSuccessfactorsSearch,
  parseSuccessfactorsJd,
} from "./successfactors.js";
import type { AdapterCompany } from "../types.js";

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

  const first = postings[0]!;
  assert.equal(first.provider, "successfactors");
  assert.equal(first.externalId, "1332433066");
  assert.equal(first.companySlug, "heromotocorp");
  assert.equal(first.jobTitle, "Team Manager - Weld Shop");
  assert.equal(first.jobUrl, "https://jobs.heromotocorp.com/job/Chittoor-Team-Manager-Weld-Shop-AP/1332433066/");
  assert.equal(first.location, "Chittoor, AP, IN");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, ""); // JD populated by fetchJd, not the listing
  assert.equal(first.postedAt, new Date("10 Jul 2026").toISOString());

  const second = postings[1]!;
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
  assert.equal(postings[0]!.externalId, "111");
  // Brand-prefixed subsidiary posting must NOT be silently dropped.
  assert.equal(postings[1]!.externalId, "12345");
  assert.equal(postings[1]!.jobUrl, "https://jobs.heromotocorp.com/SomeBrand/job/foo-bar/12345/");
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
  assert.equal(postings[0]!.externalId, "56793244");
  assert.equal(postings[0]!.jobTitle, "Deputy Buyer - Kids wear");
  assert.equal(postings[0]!.location, "Mumbai, Maharashtra, India");
  assert.match(postings[0]!.jobUrl, /careers\.example\.com|\/job\/Mumbai-Deputy-Buyer-Kids-wear-Maha\/56793244\//);
});
