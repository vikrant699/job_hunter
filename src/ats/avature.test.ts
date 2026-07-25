// src/ats/avature.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avatureSearchUrl,
  parseJobDetailHref,
  parseAvatureNextHref,
  parseAvatureSearch,
  parseAvatureJd,
} from "./avature.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "avature",
  slug: "lenovo",
  name: "Lenovo",
  careersUrl: "https://jobs.lenovo.com/en_US/careers/SearchJobs",
  tenantUrl: null,
  apiMeta: null,
};

// Article 1 mirrors Lenovo's skin: plain <span> subtitle siblings, each with a
// text prefix ("Req #:" / "Posted"), title link straight to a "slug/id" JobDetail
// href, top-of-page pagination block with the Next <a> carrying the class itself.
// Article 2 mirrors Siemens's skin: `.list-item-location` (+ jobCity/jobState/
// jobCountry sub-spans) and `.list-item-jobId`, title link to a bare-id
// JobDetail href (no slug segment).
const SEARCH_HTML = `
<html><body>
  <div class="list-controls__pagination">
    <a class="list-controls__pagination__item paginationNextLink"
       href="https://jobs.lenovo.com/en_US/careers/SearchJobs/?jobRecordsPerPage=10&amp;jobOffset=10"
       aria-label="Go to Next Page, Number 2">Next &gt;&gt;</a>
  </div>
  <div class="section__content__results">
    <article class="article article--result">
      <div class="article__header">
        <div class="article__header__text">
          <h3 class="article__header__text__title article__header__text__title--4">
            <a href="https://jobs.lenovo.com/en_US/careers/JobDetail/Staff-Firmware-Engineer-I-UEFI/79246">
              Staff Firmware Engineer I – UEFI
            </a>
          </h3>
          <div class="article__header__text__subtitle">
            <span>India, Karnataka, BANGALORE</span><br>
            <span>Req #: WD00101581</span><br>
            <span>Posted 10-Jul-2026</span>
          </div>
        </div>
      </div>
    </article>
    <article class="article article--result 1" id="article--1">
      <div class="article__header">
        <div class="article__header__text">
          <h3 class="article__header__text__title title title--h3 title--white">
            <a class="link" href="https://jobs.siemens.com/en_US/externaljobs/JobDetail/507993">
              Data Migration - Solution Consultant
            </a>
          </h3>
          <div class="article__header__text__subtitle">
            <span class="list-item-location">
              <span class="list-item-jobCity">Pune</span><span class="separator">, </span>
              <span class="list-item-jobState">Maharashtra</span><span class="separator">, </span>
              <span class="list-item-jobCountry">India</span>
            </span>
            <span class="separator">&nbsp;•&nbsp;</span>
            <span class="list-item-jobId">Job ID: 507993</span>
            <span class="separator">&nbsp;•&nbsp;</span>
            <span class="list-item-family">Information Technology</span>
          </div>
        </div>
      </div>
    </article>
  </div>
</body></html>`;

// Past-the-last-page fallback: a stale placeholder article with no title
// link, but the pagination widget still (buggily) renders a Next link.
const NO_JOBS_HTML = `
<html><body>
  <div class="list-controls__pagination">
    <a class="list-controls__pagination__item paginationNextLink"
       href="https://jobs.lenovo.com/en_US/careers/SearchJobs/?jobRecordsPerPage=10&amp;jobOffset=10">Next &gt;&gt;</a>
  </div>
  <div class="section__content__results">
    <article class="article article--result">
      <div class="article__header">
        <div class="article__header__text">
          <h3 class="article__header__text__title article__header__text__title--6">No jobs found</h3>
        </div>
      </div>
    </article>
  </div>
</body></html>`;

// Siemens-style Next link: `.paginationNextLink` is on the wrapping <li>, not
// the <a> itself.
const SIEMENS_PAGINATION_HTML = `
<div class="list-controls__pagination">
  <nav aria-label="Pagination Navigation">
    <ul class="list-controls__pagination__list">
      <li class="list-controls__pagination__item paginationNextLink">
        <a href="https://jobs.siemens.com/en_US/externaljobs/SearchJobs/?folderRecordsPerPage=6&amp;folderOffset=6"
           aria-label="Go to Next Page, Number 2">Next &gt;&gt;</a>
      </li>
    </ul>
  </nav>
</div>`;

const JD_HTML = `
<html><body>
  <div class="section__content">
    <article class="article article--details js_collapsible">
      <div class="article__content"><div class="article__content__view">
        <div class="article__content__view__field">
          <div class="article__content__view__field__label">Req #</div>
          <div class="article__content__view__field__value">WD00101581</div>
        </div>
      </div></div>
    </article>
    <article class="article article--details js_collapsible">
      <div class="article__content"><p>Own the weld shop.</p><ul><li>Lead the team</li></ul></div>
    </article>
  </div>
</body></html>`;

test("avatureSearchUrl appends /SearchJobs to a portal-root careersUrl", () => {
  assert.equal(
    avatureSearchUrl({ ...company, careersUrl: "https://jobs.lenovo.com/en_US/careers" }),
    "https://jobs.lenovo.com/en_US/careers/SearchJobs",
  );
  assert.equal(
    avatureSearchUrl({ ...company, careersUrl: "https://jobs.lenovo.com/en_US/careers/" }),
    "https://jobs.lenovo.com/en_US/careers/SearchJobs",
  );
});

test("avatureSearchUrl is idempotent when careersUrl is already the SearchJobs URL", () => {
  assert.equal(
    avatureSearchUrl({ ...company, careersUrl: "https://jobs.lenovo.com/en_US/careers/SearchJobs?foo=bar" }),
    "https://jobs.lenovo.com/en_US/careers/SearchJobs",
  );
});

test("parseJobDetailHref reads slug+id and bare-id shapes, rejects other paths", () => {
  assert.deepEqual(parseJobDetailHref("/en_US/careers/JobDetail/Staff-Firmware-Engineer-I-UEFI/79246"), {
    slug: "Staff-Firmware-Engineer-I-UEFI",
    id: "79246",
  });
  assert.deepEqual(parseJobDetailHref("/en_US/externaljobs/JobDetail/507993"), {
    slug: null,
    id: "507993",
  });
  assert.deepEqual(parseJobDetailHref("/en_US/careers/JobDetail/slug/42/?lang=en"), {
    slug: "slug",
    id: "42",
  });
  assert.equal(parseJobDetailHref("/en_US/careers/SearchJobs?q=foo"), null);
  assert.equal(parseJobDetailHref("/en_US/careers/JobDetail/"), null);
});

test("parseAvatureNextHref resolves the Next <a> when the class sits on the <a> itself", () => {
  const href = parseAvatureNextHref(SEARCH_HTML, "https://jobs.lenovo.com/en_US/careers/SearchJobs");
  assert.equal(href, "https://jobs.lenovo.com/en_US/careers/SearchJobs/?jobRecordsPerPage=10&jobOffset=10");
});

test("parseAvatureNextHref resolves the Next <a> when the class sits on a wrapping <li>", () => {
  const href = parseAvatureNextHref(SIEMENS_PAGINATION_HTML, "https://jobs.siemens.com/en_US/externaljobs/SearchJobs");
  assert.equal(href, "https://jobs.siemens.com/en_US/externaljobs/SearchJobs/?folderRecordsPerPage=6&folderOffset=6");
});

test("parseAvatureNextHref returns null when there is no Next link", () => {
  assert.equal(parseAvatureNextHref("<html><body>no pagination here</body></html>", "https://x.avature.net"), null);
});

test("parseAvatureSearch parses both skins: plain-span subtitle and list-item-location subtitle", () => {
  const { postings, nextHref } = parseAvatureSearch(
    SEARCH_HTML,
    "https://jobs.lenovo.com/en_US/careers/SearchJobs",
    company,
  );
  assert.equal(postings.length, 2);
  assert.equal(nextHref, "https://jobs.lenovo.com/en_US/careers/SearchJobs/?jobRecordsPerPage=10&jobOffset=10");

  const first = postings[0]!;
  assert.equal(first.provider, "avature");
  assert.equal(first.externalId, "79246");
  assert.equal(first.companySlug, "lenovo");
  assert.equal(first.jobTitle, "Staff Firmware Engineer I – UEFI");
  assert.equal(first.jobUrl, "https://jobs.lenovo.com/en_US/careers/JobDetail/Staff-Firmware-Engineer-I-UEFI/79246");
  assert.equal(first.location, "India, Karnataka, BANGALORE");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, "");
  assert.equal(first.postedAt, new Date("10-Jul-2026").toISOString());

  const second = postings[1]!;
  assert.equal(second.externalId, "507993"); // from the JobDetail URL, not "Job ID: 507993" text
  assert.equal(second.jobUrl, "https://jobs.siemens.com/en_US/externaljobs/JobDetail/507993");
  assert.equal(second.location, "Pune, Maharashtra, India");
  assert.equal(second.postedAt, null); // this skin shows no posted date in the listing
});

test("parseAvatureSearch marks a remote-flavored location as remote", () => {
  const html = SEARCH_HTML.replace("India, Karnataka, BANGALORE", "Remote - India");
  const { postings } = parseAvatureSearch(html, "https://jobs.lenovo.com", company);
  assert.equal(postings[0]!.location, "Remote - India");
  assert.equal(postings[0]!.isRemote, true);
});

test("parseAvatureSearch drops the stale 'No jobs found' placeholder (no title link) and does not loop on its bogus Next link", () => {
  const { postings, nextHref } = parseAvatureSearch(
    NO_JOBS_HTML,
    "https://jobs.lenovo.com/en_US/careers/SearchJobs",
    company,
  );
  assert.equal(postings.length, 0);
  // nextHref is still reported by the parser (it's genuinely present in the
  // HTML) — it's the *adapter's* listPostings loop that must stop on a
  // zero-posting page regardless of this value.
  assert.equal(nextHref, "https://jobs.lenovo.com/en_US/careers/SearchJobs/?jobRecordsPerPage=10&jobOffset=10");
});

test("parseAvatureSearch on an empty page yields zero postings and a null nextHref", () => {
  const { postings, nextHref } = parseAvatureSearch(
    "<html><body><div class='section__content__results'></div></body></html>",
    "https://jobs.lenovo.com",
    company,
  );
  assert.equal(postings.length, 0);
  assert.equal(nextHref, null);
});

test("parseAvatureSearch on malformed HTML yields zero postings, no throw", () => {
  const { postings, nextHref } = parseAvatureSearch("<not-real><<>garbage", "https://jobs.lenovo.com", company);
  assert.equal(postings.length, 0);
  assert.equal(nextHref, null);
});

test("parseAvatureJd extracts and strips the .section__content HTML", () => {
  const jd = parseAvatureJd(JD_HTML);
  assert.match(jd, /Req #/);
  assert.match(jd, /WD00101581/);
  assert.match(jd, /Own the weld shop/);
  assert.match(jd, /Lead the team/);
  assert.doesNotMatch(jd, /<li>|<div>|<p>/i);
});

test("parseAvatureJd returns empty string when .section__content is absent", () => {
  assert.equal(parseAvatureJd("<html><body><p>nothing</p></body></html>"), "");
});
