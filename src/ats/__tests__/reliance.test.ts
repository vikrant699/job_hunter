// src/ats/reliance.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFormFields,
  parseRelianceListPage,
  relianceExternalId,
  parseRelianceDate,
  normalizeReliance,
  buildPageRequestBody,
  parseRelianceJd,
  relianceAdapter,
  RELIANCE_BOARD_URL,
} from "../reliance.js";
import type { RelianceJobRow } from "../reliance.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "reliance", slug: "reliance", name: "Reliance Industries",
  careersUrl: RELIANCE_BOARD_URL, tenantUrl: null, apiMeta: null,
};

// Fixture: page 1 of a 2-page board (real markup has a duplicated `href`
// attribute on the anchor — the second one is the URL-encoded title, a
// pre-existing bug on the live site — so the fixture reproduces that to
// prove cheerio (and our parser) picks the first, real href).
function listPageHtml(opts: {
  rows: { title: string; jbid: string; functionalArea: string; location: string; postedOn: string }[];
  currentPage: number;
  totalPages: number;
  viewstate: string;
}): string {
  const rowsHtml = opts.rows
    .map(
      (r, i) => `
      <tr>
        <td><span id="MainContent_rgJobs_lblsrno_${i}">${i + 1}</span></td>
        <td><a id="MainContent_rgJobs_hylUser_${i}" href="frmJobSearch.aspx?JBTITLE=xyz${i}==&amp;jbID=${r.jbid}" href="${encodeURIComponent(r.title)}">${r.title}</a></td>
        <td>${r.functionalArea}</td>
        <td>${r.location}</td>
        <td>${r.postedOn}</td>
      </tr>`,
    )
    .join("");

  const pagerRow = `
      <tr>
        <td colspan="5">
          <div class="table-result-wrap">
            <span id="MainContent_rgJobs_CurrentPageLabel" style="color:Black;">Showing ${opts.currentPage} of ${opts.totalPages} Pages</span>
            <ul>
              <li><input type="submit" name="ctl00$MainContent$rgJobs$ctl13$lnkPrev" value="Previous" id="MainContent_rgJobs_lnkPrev" /></li>
              <li>
                <select name="ctl00$MainContent$rgJobs$ctl13$PageDropDownList" id="MainContent_rgJobs_PageDropDownList">
                  ${Array.from({ length: opts.totalPages }, (_, i) => i + 1)
                    .map((p) => `<option${p === opts.currentPage ? ' selected="selected"' : ""} value="${p}">${String(p).padStart(2, "0")}</option>`)
                    .join("")}
                </select>
              </li>
              <li><input type="submit" name="ctl00$MainContent$rgJobs$ctl13$lnkNext" value="Next" id="MainContent_rgJobs_lnkNext" /></li>
            </ul>
          </div>
        </td>
      </tr>`;

  return `<!DOCTYPE html>
<html><body>
<form name="Form1" method="post" action="./frmjobsearch.Aspx" id="Form1">
  <input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
  <input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />
  <input type="hidden" name="__LASTFOCUS" id="__LASTFOCUS" value="" />
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${opts.viewstate}" />
  <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="64AB4ABD" />
  <input type="hidden" name="__VIEWSTATEENCRYPTED" id="__VIEWSTATEENCRYPTED" value="" />
  <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="EVVAL-${opts.currentPage}" />
  <input type="text" name="ctl00$UserControl$txtKeyword" id="txtKeyword" value="" />
  <input type="submit" name="ctl00$UserControl$btnSearch" value="Search" />
  <select name="ctl00$UserControl$ddlFunction" id="ddlFunction">
    <option selected="selected" value="0">All</option>
    <option value="1">Manufacturing</option>
  </select>
  <select name="ctl00$MainContent$ddlentries" id="MainContent_ddlentries">
    <option value="5">05</option>
    <option selected="selected" value="10">10</option>
  </select>
  <table class="mytable" id="MainContent_rgJobs">
    <thead><tr><th>#</th><th>Job Title</th><th>Functional Area</th><th>Location</th><th>Posted On</th></tr></thead>
    <tbody>${rowsHtml}${pagerRow}</tbody>
  </table>
</form>
</body></html>`;
}

const page1Rows = [
  { title: "CS Operations Lead 2 - CS ( 82861680 )", jbid: "aaa1", functionalArea: "Corporate Services", location: "Jamnagar", postedOn: "10 Jul 2026" },
  { title: "Engr Maint - C2 ROGC SG/USG Instru ( 82859263 )", jbid: "aaa2", functionalArea: "Manufacturing", location: "Jamnagar", postedOn: "09 Jul 2026" },
];
const page2Rows = [
  { title: "Technologist - PSF CP ( 81813262 )", jbid: "bbb1", functionalArea: "Manufacturing", location: "Patalganga", postedOn: "17 Oct 2024" },
  { title: "REAM Engineering Maintenance Specialist ( 81900011 )", jbid: "bbb2", functionalArea: "Manufacturing", location: "Hazira", postedOn: "01 Jan 2025" },
];

const PAGE1_HTML = listPageHtml({ rows: page1Rows, currentPage: 1, totalPages: 2, viewstate: "VS-PAGE-1" });
const PAGE2_HTML = listPageHtml({ rows: page2Rows, currentPage: 2, totalPages: 2, viewstate: "VS-PAGE-2" });

// Reproduces the live site's actual quirk: the Facebook/LinkedIn share
// buttons have unescaped, literal "<url>" placeholders inside their href
// attribute values (invalid HTML), which would confuse a naive regex-based
// tag stripper. Also includes the Apply/Back <input> buttons that sit inside
// the same div on the real page — neither should leak into the JD text.
const JD_HTML = `<!DOCTYPE html>
<html><body>
<div id="MainContent_divDesc">
  <h1><span id="MainContent_lblJobTitle">CS Operations Lead 2 - CS [82861680]</span></h1>
  <div data-layout="button" class="in-class" data-size="small"><a href="http://www.facebook.com/share.php?u=<url>" onclick="return fbs_click()" target="_blank" class="facebookicon"></a></div>
  <div data-layout="button" class="in-class"><a target="_blank" href="https://www.linkedin.com/shareArticle?mini=true&url=<url>&title=Ril%20Jobs" onclick="return Linkdn_click()" class="linkendinicon"></a></div>
  <input type="submit" name="ctl00$MainContent$btnapply1" value="Apply now" id="MainContent_btnapply1" />
  <input type="submit" name="ctl00$MainContent$btntoggle1" value="Back to search results" id="MainContent_btntoggle1" />
  <p>Posted Date : 10 Jul 2026</p>
  <p>Function/Business Area : Corporate Services</p>
  <p>Location : Jamnagar</p>
  <p>Job Responsibilities :</p>
  <p>Supervise &amp; monitor overall transport administration at site.</p>
  <p>Education Requirement :</p>
  <p>Graduate in any field.</p>
  <p>Skills &amp; Competencies :</p>
  <p>Strong communicator, fluent in MS Office and SAP.</p>
</div>
</body></html>`;

test("extractFormFields pulls hidden __VIEWSTATE/__EVENTVALIDATION state and select values, excludes submit buttons", () => {
  const fields = extractFormFields(PAGE1_HTML);
  assert.equal(fields["__VIEWSTATE"], "VS-PAGE-1");
  assert.equal(fields["__EVENTVALIDATION"], "EVVAL-1");
  assert.equal(fields["__VIEWSTATEGENERATOR"], "64AB4ABD");
  assert.equal(fields["ctl00$UserControl$txtKeyword"], "");
  assert.equal(fields["ctl00$UserControl$ddlFunction"], "0");
  assert.equal(fields["ctl00$MainContent$ddlentries"], "10");
  assert.equal(fields["ctl00$MainContent$rgJobs$ctl13$PageDropDownList"], "1");
  assert.equal(fields["ctl00$UserControl$btnSearch"], undefined, "submit buttons must not be included");
  assert.equal(fields["ctl00$MainContent$rgJobs$ctl13$lnkNext"], undefined);
});

test("parseRelianceListPage: page 1 of 2 — parses rows and picks the real href over the duplicated attribute", () => {
  const page = parseRelianceListPage(PAGE1_HTML);
  assert.equal(page.currentPage, 1);
  assert.equal(page.totalPages, 2);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0]?.title, "CS Operations Lead 2 - CS ( 82861680 )");
  assert.equal(page.rows[0].href, "frmJobSearch.aspx?JBTITLE=xyz0==&jbID=aaa1");
  assert.equal(page.rows[0].location, "Jamnagar");
  assert.equal(page.rows[0].functionalArea, "Corporate Services");
  assert.equal(page.rows[0].postedOn, "10 Jul 2026");
});

test("parseRelianceListPage: page 2 of 2 — different rows, currentPage advances", () => {
  const page = parseRelianceListPage(PAGE2_HTML);
  assert.equal(page.currentPage, 2);
  assert.equal(page.totalPages, 2);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0]?.title, "Technologist - PSF CP ( 81813262 )");
});

test("parseRelianceListPage: no pager row (small board) defaults to page 1 of 1", () => {
  const html = `<html><body><table id="MainContent_rgJobs"><tbody>
    <tr><td>1</td><td><a href="frmJobSearch.aspx?JBTITLE=a&amp;jbID=b">Solo Role ( 1 )</a></td><td>F</td><td>Mumbai</td><td>01 Jan 2026</td></tr>
  </tbody></table></body></html>`;
  const page = parseRelianceListPage(html);
  assert.equal(page.currentPage, 1);
  assert.equal(page.totalPages, 1);
  assert.equal(page.rows.length, 1);
});

test("relianceExternalId extracts the numeric requisition code from the title", () => {
  assert.equal(relianceExternalId({ title: "CS Operations Lead 2 - CS ( 82861680 )", href: "x" }), "82861680");
  assert.equal(relianceExternalId({ title: "Some Role [82852018]", href: "x" }), "82852018");
});

test("relianceExternalId falls back to a title slug, not the encrypted href", () => {
  const id = relianceExternalId({ title: "CS Operations Lead - CS", href: "frmJobSearch.aspx?JBTITLE=xyzenc&jbID=abc123enc" });
  assert.equal(id, "cs-operations-lead-cs");
});

test("parseRelianceDate parses the site's DD Mon YYYY format, null on garbage", () => {
  assert.ok(parseRelianceDate("10 Jul 2026") !== null);
  assert.equal(parseRelianceDate("not a date"), null);
});

test("normalizeReliance maps fields: resolved absolute job URL, requisition-code external id, no JD yet", () => {
  const p = normalizeReliance(company, at(page1Rows.map(rowFromFixture), 0));
  assert.equal(p.provider, "reliance");
  assert.equal(p.externalId, "82861680");
  assert.equal(p.jobTitle, "CS Operations Lead 2 - CS ( 82861680 )");
  assert.equal(p.jobUrl, "https://careers.ril.com/rilcareers/frmJobSearch.aspx?JBTITLE=xyz0==&jbID=aaa1");
  assert.equal(p.location, "Jamnagar");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("10 Jul 2026").toISOString());
});

test("normalizeReliance: remote-sounding location/function sets isRemote true", () => {
  const row: RelianceJobRow = {
    title: "Remote Consultant ( 1 )", href: "frmJobSearch.aspx?JBTITLE=a&jbID=b",
    functionalArea: "Remote", location: "Work From Home", postedOn: "01 Jan 2026",
  };
  assert.equal(normalizeReliance(company, row).isRemote, true);
});

test("buildPageRequestBody sets __EVENTTARGET to the pager select and overrides its value to the target page", () => {
  const fields = extractFormFields(PAGE1_HTML);
  const body = buildPageRequestBody(fields, 2);
  assert.equal(body["__EVENTTARGET"], "ctl00$MainContent$rgJobs$ctl13$PageDropDownList");
  assert.equal(body["__EVENTARGUMENT"], "");
  assert.equal(body["ctl00$MainContent$rgJobs$ctl13$PageDropDownList"], "2");
  // Unrelated state fields are preserved unchanged from the source page.
  assert.equal(body["__VIEWSTATE"], "VS-PAGE-1");
  assert.equal(body["ctl00$MainContent$ddlentries"], "10");
});

test("parseRelianceJd extracts and strips the detail page's description div", () => {
  const jd = parseRelianceJd(JD_HTML);
  assert.match(jd, /Job Responsibilities/);
  assert.match(jd, /Supervise & monitor overall transport/);
  assert.match(jd, /Strong communicator/);
  assert.doesNotMatch(jd, /<p>|<div/);
});

test("parseRelianceJd drops the share-button noise (malformed <url> hrefs) and Apply/Back buttons", () => {
  const jd = parseRelianceJd(JD_HTML);
  assert.doesNotMatch(jd, /fbs_click|facebookicon|linkendinicon|onclick/);
  assert.doesNotMatch(jd, /Apply now|Back to search results/);
  assert.doesNotMatch(jd, /<url>/);
});

test("parseRelianceJd returns empty string when the description div is absent", () => {
  assert.equal(parseRelianceJd("<html><body>nothing here</body></html>"), "");
});

// --- Adapter integration: exercise the real __VIEWSTATE paging loop end to end ---

test("relianceAdapter.listPostings pages through both fixture pages via the __VIEWSTATE postback loop", async (t) => {
  let postCount = 0;
  stubFetch(t, async (_input, init) => {
    if (init?.method === "POST") {
      postCount += 1;
      const body = String(init.body);
      const params = new URLSearchParams(body);
      assert.equal(params.get("__EVENTTARGET"), "ctl00$MainContent$rgJobs$ctl13$PageDropDownList");
      assert.equal(params.get("__VIEWSTATE"), "VS-PAGE-1", "must re-post the freshly extracted page-1 viewstate");
      assert.equal(params.get("ctl00$MainContent$rgJobs$ctl13$PageDropDownList"), "2");
      return new Response(PAGE2_HTML, { status: 200 });
    }
    return new Response(PAGE1_HTML, { status: 200 });
  });
  const postings = await relianceAdapter.listPostings(company);
  assert.equal(postCount, 1, "a 2-page board should need exactly one postback");
  assert.equal(postings.length, 4);
  assert.equal(postings[0]?.jobTitle, "CS Operations Lead 2 - CS ( 82861680 )");
  assert.equal(postings[2]?.jobTitle, "Technologist - PSF CP ( 81813262 )");
  assert.deepEqual(
    postings.map((p) => p.externalId),
    ["82861680", "82859263", "81813262", "81900011"],
  );
});

test("relianceAdapter.listPostings makes no postback at all for a single-page board", async (t) => {
  const single = listPageHtml({ rows: page1Rows.slice(0, 1), currentPage: 1, totalPages: 1, viewstate: "VS-ONLY" });
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return new Response(single, { status: 200 });
  });
  const postings = await relianceAdapter.listPostings(company);
  assert.equal(calls, 1);
  assert.equal(postings.length, 1);
});

test("relianceAdapter.listPostings throws instead of looping forever if the server never advances the page", async (t) => {
  stubFetch(t, async (_input, init) => {
    if (init?.method === "POST") return new Response(PAGE1_HTML, { status: 200 }); // stuck on page 1
    return new Response(PAGE1_HTML, { status: 200 });
  });
  await assert.rejects(relianceAdapter.listPostings(company), /pagination stuck/);
});

test("relianceAdapter.fetchJd fetches the posting's job URL and extracts the description div", async (t) => {
  let fetchedUrl = "";
  stubFetch(t, async (input) => {
    fetchedUrl = String(input);
    return new Response(JD_HTML, { status: 200 });
  });
  const posting = normalizeReliance(company, rowFromFixture(at(page1Rows, 0)));
  assert(relianceAdapter.fetchJd);
  const jd = await relianceAdapter.fetchJd(company, posting);
  assert.equal(fetchedUrl, posting.jobUrl);
  assert.match(jd, /Job Responsibilities/);
});

// Helper: turn a fixture row spec into the RelianceJobRow shape parseRelianceListPage would produce.
function rowFromFixture(r: { title: string; jbid: string; functionalArea: string; location: string; postedOn: string }): RelianceJobRow {
  const i = page1Rows.indexOf(r);
  return {
    title: r.title,
    href: `frmJobSearch.aspx?JBTITLE=xyz${i}==&jbID=${r.jbid}`,
    functionalArea: r.functionalArea,
    location: r.location,
    postedOn: r.postedOn,
  };
}
