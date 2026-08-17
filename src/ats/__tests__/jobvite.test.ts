// src/ats/__tests__/jobvite.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobviteAdapter,
  jobviteTenant,
  jobviteSearchUrl,
  parseJobviteList,
  parseJobviteJd,
} from "../jobvite.js";
import { at, fetchSequence, htmlResponse, htmlResponseFrom, stubFetch } from "./testHelpers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "jobvite",
  slug: "barracuda",
  name: "Barracuda India",
  careersUrl: "https://jobs.jobvite.com/barracuda-networks-inc",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed real markup: leading-asterisk title, plain state location, and a "2 Locations" jv-meta row.
function listHtml(rows: string, paginationText: string | null): string {
  return `
<html><body><div class="jv-wrapper">
  <table class="jv-job-list jv-search-list">
    <thead><tr><th scope="col" class="jv-cws-sr-only">Job listing</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${paginationText === null ? "" : `<div class="jv-pagination"><div class="jv-pagination-text">${paginationText}</div><a href="/barracuda-networks-inc/search/?p=1" class="jv-pagination-next"></a></div>`}
</div></body></html>`;
}

const ROWS_PAGE_0 = `
  <tr>
    <td class="jv-job-list-name"><a href="/barracuda-networks-inc/job/o9TtAfwP">* Sales Renewals Representative</a></td>
    <td class="jv-job-list-location">  Campbell,            California  </td>
  </tr>
  <tr>
    <td class="jv-job-list-name"><a href="/barracuda-networks-inc/job/oC6AAfwC">AI Content Manager</a></td>
    <td class="jv-job-list-location"><div class="jv-meta">  2 Locations  </div></td>
  </tr>`;

const ROWS_PAGE_1 = `
  <tr>
    <td class="jv-job-list-name"><a href="/barracuda-networks-inc/job/oVozAfwc">Software Engineer (Remote)</a></td>
    <td class="jv-job-list-location">  Bengaluru, India  </td>
  </tr>`;

// Trimmed real markup: meta is department then locations, separated by jv-inline-separator spans.
const JD_HTML = `
<html><body>
  <h2 class="jv-header">  * Sales Renewals Representative  </h2>
  <p class="jv-job-detail-meta">
    Sales &amp; Renewals <span class='jv-inline-separator'></span>
    Michigan <span class="jv-inline-separator"></span> Georgia
  </p>
  <div class="jv-job-detail-description" ng-non-bindable>
    <p>Come Join Our <b>Passionate</b> Team!</p><p>We make the world a safer place.</p>
  </div>
</body></html>`;

test("jobviteTenant extracts the tenant token from the board URL", () => {
  assert.equal(jobviteTenant(company), "barracuda-networks-inc");
  assert.equal(
    jobviteTenant({ ...company, careersUrl: "https://jobs.jobvite.com/barracuda-networks-inc/search?q=" }),
    "barracuda-networks-inc",
  );
  assert.throws(() => jobviteTenant({ ...company, careersUrl: "https://example.com/careers" }));
});

test("jobviteSearchUrl pages 0-based under /search/", () => {
  assert.equal(jobviteSearchUrl("barracuda-networks-inc", 0), "https://jobs.jobvite.com/barracuda-networks-inc/search/?p=0");
  assert.equal(jobviteSearchUrl("barracuda-networks-inc", 2), "https://jobs.jobvite.com/barracuda-networks-inc/search/?p=2");
});

test("parseJobviteList extracts rows, ids and the pagination total", () => {
  const { jobs, total } = parseJobviteList(listHtml(ROWS_PAGE_0, "1-50 of 53"));
  assert.equal(total, 53);
  assert.equal(jobs.length, 2);
  const first = at(jobs, 0);
  assert.equal(first.id, "o9TtAfwP");
  assert.equal(first.title, "* Sales Renewals Representative");
  assert.equal(first.location, "Campbell, California");
  // "2 Locations" placeholder rows keep the placeholder; fetchJd refines it.
  assert.equal(at(jobs, 1).location, "2 Locations");
});

test("parseJobviteList reports no total when the board has a single page", () => {
  const { jobs, total } = parseJobviteList(listHtml(ROWS_PAGE_1, null));
  assert.equal(total, null);
  assert.equal(jobs.length, 1);
});

test("listPostings paginates to the total and normalizes", async (t) => {
  stubFetch(t, fetchSequence(
    () => htmlResponse(listHtml(ROWS_PAGE_0, "1-2 of 3")),
    () => htmlResponse(listHtml(ROWS_PAGE_1, "3-3 of 3")),
  ));
  const postings = await jobviteAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  const first = at(postings, 0);
  assert.equal(first.provider, "jobvite");
  assert.equal(first.externalId, "o9TtAfwP");
  assert.equal(first.jobUrl, "https://jobs.jobvite.com/barracuda-networks-inc/job/o9TtAfwP");
  assert.equal(first.location, "Campbell, California");
  assert.equal(first.isRemote, false);
  assert.equal(first.postedAt, null);
  const remote = at(postings, 2);
  assert.equal(remote.isRemote, true);
  assert.equal(remote.location, "Bengaluru, India");
});

test("listPostings throws on a dead tenant (redirect off the board host)", async (t) => {
  stubFetch(t, fetchSequence(
    () => htmlResponseFrom("https://www.jobvite.com/support/job-seeker-support/?invalid=1", "<html><body>Job Seeker Support</body></html>"),
  ));
  await assert.rejects(jobviteAdapter.listPostings(company), /tenant/i);
});

test("parseJobviteJd extracts text and the meta locations (department stripped)", () => {
  const { jdText, location } = parseJobviteJd(JD_HTML);
  assert.match(jdText, /Come Join Our Passionate Team!/);
  assert.match(jdText, /world a safer place/);
  assert.equal(location, "Michigan; Georgia");
});

test("fetchJd refines a placeholder location from the detail meta", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(JD_HTML)));
  const posting = {
    provider: "jobvite" as const,
    externalId: "oC6AAfwC",
    companySlug: "barracuda",
    companyName: "Barracuda India",
    jobTitle: "AI Content Manager",
    jobUrl: "https://jobs.jobvite.com/barracuda-networks-inc/job/oC6AAfwC",
    location: "2 Locations",
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
  const jd = await jobviteAdapter.fetchJd?.(company, posting);
  assert.match(jd ?? "", /safer place/);
  assert.equal(posting.location, "Michigan; Georgia");
});
