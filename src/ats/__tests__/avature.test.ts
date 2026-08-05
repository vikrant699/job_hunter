// src/ats/avature.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAvatureBoardServed,
  avatureAdapter,
  avatureEngineServed,
  avatureSearchUrl,
  parseJobDetailHref,
  parseAvatureNextHref,
  parseAvatureSearch,
  parseAvatureJd,
} from "../avature.js";
import type { AdapterCompany } from "../../types.js";
import { at, CHALLENGE_PAGE_HTML, fetchSequence, htmlResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/error-cause.js";

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

  const first = at(postings, 0);
  assert.equal(first.provider, "avature");
  assert.equal(first.externalId, "79246");
  assert.equal(first.companySlug, "lenovo");
  assert.equal(first.jobTitle, "Staff Firmware Engineer I – UEFI");
  assert.equal(first.jobUrl, "https://jobs.lenovo.com/en_US/careers/JobDetail/Staff-Firmware-Engineer-I-UEFI/79246");
  assert.equal(first.location, "India, Karnataka, BANGALORE");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, "");
  assert.equal(first.postedAt, new Date("10-Jul-2026").toISOString());

  const second = at(postings, 1);
  assert.equal(second.externalId, "507993"); // from the JobDetail URL, not "Job ID: 507993" text
  assert.equal(second.jobUrl, "https://jobs.siemens.com/en_US/externaljobs/JobDetail/507993");
  assert.equal(second.location, "Pune, Maharashtra, India");
  assert.equal(second.postedAt, null); // this skin shows no posted date in the listing
});

test("parseAvatureSearch marks a remote-flavored location as remote", () => {
  const html = SEARCH_HTML.replace("India, Karnataka, BANGALORE", "Remote - India");
  const { postings } = parseAvatureSearch(html, "https://jobs.lenovo.com", company);
  assert.equal(at(postings, 0).location, "Remote - India");
  assert.equal(at(postings, 0).isRemote, true);
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

// --- portal no longer served vs genuinely empty portal --------------------------

// The engine's meta namespace, verbatim from every live capture (2026-08-03) —
// jobs.lenovo.com, careers.tesco.com, www.metlifecareers.com and jobsearch.harman.com
// all stamp it, custom host or avature.net alike.
const PORTAL_META = `<meta name="avature.wizard.registrars" content="[]"/>
<meta name="avature.portal.id" content="4"/>
<meta name="avature.portal.urlPath" content="careers"/>
<meta name="avature.portal.lang" content="en_US"/>`;

// Trimmed from GET https://jobs.lenovo.com/en_US/careers/ (HTTP 200, captured
// 2026-08-03): a LIVE portal page carrying zero article--result blocks while still
// stamping the meta namespace. Same shape as www.metlifecareers.com's home. This is
// what a portal with nothing open looks like, and it must keep returning [].
const EMPTY_PORTAL_HTML = `
<html><head>${PORTAL_META}</head><body>
  <div class="section__content__results"></div>
</body></html>`;

// The shape of a custom host that stopped serving Avature: 200, no result
// articles, and none of the engine's markup (verified against radancy, jobsoid and
// superworks boards, which carry neither marker).
const NOT_A_PORTAL_HTML = `
<html><head><title>Careers at Lenovo</title></head><body>
  <h1>Come work with us</h1>
  <p>Our openings have moved. Please visit our new careers site.</p>
</body></html>`;

// Trimmed from GET jobs.lenovo.com/en_US/careers/SearchJobs?jobOffset=99990
// (HTTP 200, captured 2026-08-03): Avature's OWN transient failure page. It drops
// every meta tag but still loads /jscore/ assets, so the engine marker has to
// accept that path too or a vendor-side hiccup would fail a healthy board.
const ENGINE_ERROR_HTML = `
<html><head><link href="/jscore/images/icons/favicon.ico" rel="shortcut icon"><title> </title></head>
<body><img src="/jscore/images/http/fatal.png" class="errorImage" alt="">
<div class="title">Oops… Something went wrong</div>
<div class="description">There was an error while processing your request. Please try again.</div>
</body></html>`;

/** Run `fn` and hand back whatever it threw, failing the test if it returned. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

test("avatureEngineServed accepts either the portal meta namespace or the /jscore/ asset path", () => {
  assert.equal(avatureEngineServed(EMPTY_PORTAL_HTML), true);
  assert.equal(avatureEngineServed(SEARCH_HTML.replace("<body>", `<head>${PORTAL_META}</head><body>`)), true);
  assert.equal(avatureEngineServed(ENGINE_ERROR_HTML), true);
  assert.equal(avatureEngineServed(NOT_A_PORTAL_HTML), false);
});

test("assertAvatureBoardServed throws only when neither engine marker is present", () => {
  assert.doesNotThrow(() => assertAvatureBoardServed(EMPTY_PORTAL_HTML, "https://jobs.lenovo.com/x"));
  assert.doesNotThrow(() => assertAvatureBoardServed(ENGINE_ERROR_HTML, "https://jobs.lenovo.com/x"));

  const err = thrownBy(() =>
    assertAvatureBoardServed(NOT_A_PORTAL_HTML, "https://jobs.lenovo.com/en_US/careers/SearchJobs"),
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /avature: portal no longer served/);
  assert.match(err.message, /jobs\.lenovo\.com/);
});

test("the dead-portal error is charged to the company, not written off as infrastructure", () => {
  // A host that stopped serving its Avature portal is a per-company board defect
  // and MUST count toward the row's consecutive_failures. If any of these flipped
  // true the scheduler would retry the board forever and never quarantine it.
  const err = thrownBy(() => assertAvatureBoardServed(NOT_A_PORTAL_HTML, "https://jobs.lenovo.com/x"));
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

// A bot-block page carries neither engine marker, so it used to be indistinguishable
// from a host that stopped serving its portal — and eight of the nine live rows sit
// on the company's own (WAF-frontable) host.
test("a WAF challenge page is an edge refusal, NOT a dead portal", () => {
  const err = thrownBy(() => assertAvatureBoardServed(CHALLENGE_PAGE_HTML, "https://jobs.siemens.com/x"));
  assert.ok(err instanceof Error);
  assert.ok(isInfrastructureFault(err), "a blocked request must not be charged to the board");
  assert.doesNotMatch(err.message, /portal no longer served/);
});

test("avatureAdapter.listPostings rejects a host that no longer serves an Avature portal", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(NOT_A_PORTAL_HTML)));
  await assert.rejects(
    () => avatureAdapter.listPostings(company),
    /avature: portal no longer served.*jobs\.lenovo\.com/s,
  );
});

test("avatureAdapter.listPostings returns [] for a LIVE portal with nothing open", async (t) => {
  // The distinction the check exists for: zero articles, but the engine's own
  // markup is there, so nothing fails.
  stubFetch(t, fetchSequence(() => htmlResponse(EMPTY_PORTAL_HTML)));
  assert.deepEqual(await avatureAdapter.listPostings(company), []);
});

test("avatureAdapter.listPostings returns [] rather than failing on the engine's own error page", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(ENGINE_ERROR_HTML)));
  assert.deepEqual(await avatureAdapter.listPostings(company), []);
});

test("avatureAdapter.listPostings still lists a populated portal unchanged", async (t) => {
  // Page 1 has a Next link, so page 2 is fetched; its stale "No jobs found"
  // placeholder ends the loop.
  stubFetch(t, fetchSequence(
    () => htmlResponse(SEARCH_HTML),
    () => htmlResponse(NO_JOBS_HTML),
  ));
  const postings = await avatureAdapter.listPostings(company);
  assert.equal(postings.length, 2);
  assert.equal(at(postings, 0).externalId, "79246");
});

test("avatureAdapter.listPostings lets a LATER page with no postings end pagination instead of failing", async (t) => {
  // NO_JOBS_HTML carries neither engine marker, and past page 1 that must still
  // read as "the pager ran off the end", not "the board is dead".
  stubFetch(t, fetchSequence(
    () => htmlResponse(SEARCH_HTML),
    () => htmlResponse(NO_JOBS_HTML),
  ));
  assert.equal(avatureEngineServed(NO_JOBS_HTML), false);
  const postings = await avatureAdapter.listPostings(company);
  assert.equal(postings.length, 2);
});

test("avatureAdapter.listPostings resolves a tenant_url override that omits /SearchJobs", async (t) => {
  // MetLife's row: tenant_url is the portal root, so /SearchJobs is appended and
  // the check must run against the page that actually comes back.
  const metlife: AdapterCompany = {
    provider: "avature",
    slug: "metlife",
    name: "MetLife",
    careersUrl: "https://www.metlifecareers.com/en_US/ml/SearchJobs",
    tenantUrl: "https://www.metlifecareers.com/en_US/ml",
    apiMeta: null,
  };
  assert.equal(avatureSearchUrl(metlife), "https://www.metlifecareers.com/en_US/ml/SearchJobs");
  stubFetch(t, fetchSequence(() => htmlResponse(EMPTY_PORTAL_HTML)));
  assert.deepEqual(await avatureAdapter.listPostings(metlife), []);
});
