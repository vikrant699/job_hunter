// src/ats/freshteam.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshteamAdapter,
  freshteamListUrl,
  parseFreshteamHref,
  parseFreshteamList,
  parseFreshteamJd,
} from "../freshteam.js";
import { fetchSequence, htmlResponse, stubFetch } from "./testHelpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "freshteam",
  slug: "krazybee",
  name: "KrazyBee",
  careersUrl: "https://krazybee.freshteam.com/jobs",
  tenantUrl: "https://krazybee.freshteam.com",
  apiMeta: null,
};

// A subdomain that no longer exists. Freshteam answers 200 here, not 404.
const deadCompany: AdapterCompany = {
  provider: "freshteam",
  slug: "niki-ai",
  name: "Niki.ai",
  careersUrl: "https://niki-talent.freshteam.com/jobs",
  tenantUrl: "https://niki-talent.freshteam.com",
  apiMeta: null,
};

const LIST_HTML = `
<html><body>
  <div data-portal-id="jobs_list">
    <a href="/jobs/jrN-FJFXaYVg/business-analyst" class="heading"
       data-portal-title="businessanalyst" data-portal-location="Bengaluru, India"
       data-portal-job-type="2" data-portal-remote-location=false>
      <div class="row">
        <div class="job-list-info">
          <div class="job-title">Business Analyst</div>
          <div class="job-desc text">Roles &amp; Responsibilities...</div>
        </div>
        <div class="job-location">
          <div class="location-info">Bengaluru<br/>Full Time</div>
        </div>
      </div>
    </a>
    <a href="/jobs/YrRrYuwyxPAH/software-engineer-l1-hybrid" class="heading"
       data-portal-title="softwareengineer-l1(hybrid)" data-portal-location="Mumbai, India"
       data-portal-job-type="1" data-portal-remote-location=true>
      <div class="row">
        <div class="job-list-info">
          <div class="job-title">Software Engineer - L1 (Hybrid)</div>
        </div>
        <div class="job-location">
          <div class="location-info">Remote<br/>Contract</div>
        </div>
      </div>
    </a>
  </div>
</body></html>
`;

const JD_HTML = `
<html><body>
  <div class="job-details-content content">
    <div><div><strong>Roles &amp; Responsibilities.<br></strong>* Track business numbers<br>* Build dashboards<br></div></div>
    <div>
      <script src="//assets.freshteam.com/portal.js"></script>
      <div class="application-form" id="applicant-form">
        <h3>Submit Your Application</h3>
        <form><input type="hidden" name="authenticity_token" value="abc" /></form>
      </div>
    </div>
  </div>
</body></html>
`;

// Freshteam's "no such subdomain" page - the tenant name isn't in the markup itself, only injected via a trailing script from document.domain.
const INVALID_DOMAIN_HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <link rel="stylesheet" href="/src/404.css" type="text/css" media="screen, projection">
    <title>Freshteam</title>
  </head>
  <body>
    <div id="wrap" class="container">
			<div class="invalid-domain-wrapper">
				<div class="wrapper-shadow">
					<div class="no-ats">
						<div class="freshteam-logo"></div>
						<h2 class="invalid-domain-header"> We couldn't find <span id="domainname"></span></h2>
						<p> May be this is still fresh!  </p>
						<p> You can claim it now at
              <a href='https://www.freshworks.com/applicant-tracking'>http://www.freshteam.com</a>
            </p>
					</div>
				</div>
			</div>
		</div>
    <script type='text/javascript'>
			document.getElementById("domainname").innerHTML = (document.domain);
    </script>
	</body>
</html>
`;

// A LIVE tenant with nothing open (real portal chrome minus the one job row) - the case the dead-tenant check must not swallow.
const EMPTY_BOARD_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>

   Careers

</title>
    <meta charset="utf-8">
    <link rel="stylesheet" media="screen" href="//assets.freshteam.com/assets/portal-6d8bb698.css" />
  </head>
  <body>
    <div class="search-container">
      <div class="search-fields">
        <select name="department_id" id="department_id" data-placeholder="Choose Department"></select>
        <select name="city_id" id="city_id" data-placeholder="Choose Location"></select>
      </div>
      <div class="input-field">
        <input class="form-control" type="text" id="job-title-search" placeholder="Search Job Title" name="query" />
      </div>
    </div>
    <div class="content">
      <!-- Do not remove data-portal-* attributes. Removing the same will result in breakages in filter behaviour. -->
      <div data-portal-id="jobs_list">
        <div class="job-role-list" data-portal-id="job-role-list">
          <ul>
          </ul>
        </div>
      </div>
      <div class="no-jobs-found" data-portal-id="no_data">
        <div class="no-jobs-icon"><i class="icon-my-job"></i></div>
        <div class="not-found-title">No jobs found</div>
        <p>Oops, you have no jobs that match the filter conditions.</p>
      </div>
    </div>
    <footer class=""></footer>
  </body>
</html>
`;

test("freshteamListUrl builds the listing URL from the tenant origin", () => {
  assert.equal(freshteamListUrl(company), "https://krazybee.freshteam.com/jobs");
  assert.equal(freshteamListUrl({ ...company, tenantUrl: null }), "https://krazybee.freshteam.com/jobs");
});

test("parseFreshteamHref extracts id + slug from a /jobs/<id>/<slug> path", () => {
  assert.deepEqual(parseFreshteamHref("/jobs/jrN-FJFXaYVg/business-analyst"), {
    id: "jrN-FJFXaYVg",
    slug: "business-analyst",
  });
  assert.deepEqual(parseFreshteamHref("/jobs/jrN-FJFXaYVg/business-analyst?src=x"), {
    id: "jrN-FJFXaYVg",
    slug: "business-analyst",
  }); // query string is stripped before segmenting
  assert.equal(parseFreshteamHref("/jobs/onlyid"), null);
  assert.equal(parseFreshteamHref("/careers/jrN-FJFXaYVg/business-analyst"), null);
});

test("parseFreshteamList maps both rows: title (from .job-title, not the slugged attr), location, isRemote, absolute URL", () => {
  const postings = parseFreshteamList(LIST_HTML, company);
  assert.equal(postings.length, 2);

  const [ba, se] = postings;
  assert.equal(ba?.provider, "freshteam");
  assert.equal(ba.externalId, "jrN-FJFXaYVg");
  assert.equal(ba.jobTitle, "Business Analyst");
  assert.equal(ba.jobUrl, "https://krazybee.freshteam.com/jobs/jrN-FJFXaYVg/business-analyst");
  assert.equal(ba.location, "Bengaluru, India");
  assert.equal(ba.isRemote, false);
  assert.equal(ba.jdText, "");
  assert.equal(ba.postedAt, null);

  assert.equal(se?.externalId, "YrRrYuwyxPAH");
  assert.equal(se.jobTitle, "Software Engineer - L1 (Hybrid)");
  assert.equal(se.location, "Mumbai, India");
  // data-portal-remote-location=true wins even though "Mumbai, India" wouldn't match REMOTE_RE.
  assert.equal(se.isRemote, true);
});

test("parseFreshteamList dedups a job id seen twice and skips a row with no href", () => {
  const dupHtml = LIST_HTML.replace(
    "</div>\n</body>",
    `<a href="/jobs/jrN-FJFXaYVg/business-analyst" data-portal-title="dup"><div class="job-title">Business Analyst</div></a>
     <a data-portal-title="nohref"><div class="job-title">No Href</div></a>
     </div>\n</body>`,
  );
  const postings = parseFreshteamList(dupHtml, company);
  assert.equal(postings.filter((p) => p.externalId === "jrN-FJFXaYVg").length, 1);
  assert.equal(postings.some((p) => p.jobTitle === "No Href"), false);
});

test("parseFreshteamList returns [] when the jobs_list container is missing (empty board / layout change)", () => {
  assert.deepEqual(parseFreshteamList("<html><body>No jobs right now.</body></html>", company), []);
});

test("parseFreshteamList skips a row whose href doesn't match /jobs/<id>/<slug> and one with no .job-title", () => {
  const malformed = `
    <div data-portal-id="jobs_list">
      <a href="/jobs/onlyid" data-portal-title="x"><div class="job-title">Bad Href</div></a>
      <a href="/jobs/abc123/slug" data-portal-title="x"></a>
    </div>`;
  assert.deepEqual(parseFreshteamList(malformed, company), []);
});

/** Run `fn` and hand back whatever it threw, failing the test if it returned. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

test("parseFreshteamList throws on Freshteam's invalid-domain page instead of reporting an empty board", () => {
  const err = thrownBy(() => parseFreshteamList(INVALID_DOMAIN_HTML, deadCompany));
  assert.ok(err instanceof Error);
  // The URL must come from the company row - the page itself never names the tenant.
  assert.match(err.message, /niki-talent\.freshteam\.com\/jobs/);
  assert.match(err.message, /tenant does not exist/);
  assert.match(err.message, /claim it now/);
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", () => {
  // Must count toward consecutive_failures, or the scheduler retries forever instead of quarantining.
  const err = thrownBy(() => parseFreshteamList(INVALID_DOMAIN_HTML, deadCompany));
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("parseFreshteamList returns [] for a LIVE tenant whose board has no open roles", () => {
  assert.deepEqual(parseFreshteamList(EMPTY_BOARD_HTML, company), []);
});

test("freshteamAdapter.listPostings rejects a dead tenant and still lists a populated board", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(INVALID_DOMAIN_HTML)));
  await assert.rejects(
    () => freshteamAdapter.listPostings(deadCompany),
    /freshteam: tenant does not exist/,
  );

  stubFetch(t, fetchSequence(() => htmlResponse(LIST_HTML)));
  const postings = await freshteamAdapter.listPostings(company);
  assert.equal(postings.length, 2);
});

test("parseFreshteamJd extracts the JD text and strips the trailing application form + script", () => {
  const jd = parseFreshteamJd(JD_HTML);
  assert.match(jd, /Track business numbers/);
  assert.match(jd, /Build dashboards/);
  assert.doesNotMatch(jd, /Submit Your Application/);
  assert.doesNotMatch(jd, /<div>|<script>/);
});

test("parseFreshteamJd returns '' when .job-details-content is absent (malformed/changed page)", () => {
  assert.equal(parseFreshteamJd("<html><body>Not found</body></html>"), "");
});

// Legacy (pre data-portal) board template, live on ninjacart - no data-portal-* attributes; location lives in a sibling .job-location block.
const LEGACY_TEMPLATE_HTML = `<html><body><ul>
  <li class="heading"><div class="row">
    <div class="job-list-info">
      <a href="/jobs/Doy_p4CnkDuE/record-to-report-bangalore" class="job-title">Record to Report - Bangalore</a>
      <a href="/jobs/Doy_p4CnkDuE/record-to-report-bangalore" class="job-desc text">Ninjacart - Pioneer...</a>
    </div>
    <div class="job-location">
      <a href="/jobs/Doy_p4CnkDuE/record-to-report-bangalore" class="location-info"> Bangalore, India <br/> Full Time </a>
    </div>
  </div></li>
  <li class="heading"><div class="row">
    <div class="job-list-info">
      <a href="/jobs/1d8yS9-LquXv/sales-hrbp" class="job-title">Sales HRBP</a>
    </div>
    <div class="job-location">
      <a href="/jobs/1d8yS9-LquXv/sales-hrbp" class="location-info"> Remote <br/> Full Time </a>
    </div>
  </div></li>
</ul></body></html>`;

test("parseFreshteamList also parses the legacy template (bare a.job-title rows, ninjacart-style)", () => {
  const posts = parseFreshteamList(LEGACY_TEMPLATE_HTML, company);
  assert.equal(posts.length, 2);
  const [rtr, hrbp] = posts;
  assert.equal(rtr?.externalId, "Doy_p4CnkDuE");
  assert.equal(rtr.jobTitle, "Record to Report - Bangalore");
  assert.equal(rtr.location, "Bangalore, India");
  assert.match(rtr.jobUrl, /^https:\/\/.*\/jobs\/Doy_p4CnkDuE\/record-to-report-bangalore$/);
  assert.equal(hrbp?.location, "Remote");
  assert.equal(hrbp.isRemote, true);
});
