// src/ats/freshteam.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshteamBase,
  freshteamListUrl,
  parseFreshteamHref,
  parseFreshteamList,
  parseFreshteamJd,
} from "./freshteam.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "freshteam",
  slug: "krazybee",
  name: "KrazyBee",
  careersUrl: "https://krazybee.freshteam.com/jobs",
  tenantUrl: "https://krazybee.freshteam.com",
  apiMeta: null,
};

// Trimmed real markup shape from GET /jobs (two rows: onsite + remote-tagged).
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

test("freshteamBase / freshteamListUrl derive the tenant origin and listing URL", () => {
  assert.equal(freshteamBase(company), "https://krazybee.freshteam.com");
  assert.equal(freshteamListUrl(company), "https://krazybee.freshteam.com/jobs");
  assert.equal(freshteamBase({ ...company, tenantUrl: null }), "https://krazybee.freshteam.com");
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
  assert.equal(ba?.externalId, "jrN-FJFXaYVg");
  assert.equal(ba?.jobTitle, "Business Analyst");
  assert.equal(ba?.jobUrl, "https://krazybee.freshteam.com/jobs/jrN-FJFXaYVg/business-analyst");
  assert.equal(ba?.location, "Bengaluru, India");
  assert.equal(ba?.isRemote, false);
  assert.equal(ba?.jdText, "");
  assert.equal(ba?.postedAt, null);

  assert.equal(se?.externalId, "YrRrYuwyxPAH");
  assert.equal(se?.jobTitle, "Software Engineer - L1 (Hybrid)");
  assert.equal(se?.location, "Mumbai, India");
  // data-portal-remote-location=true wins even though the raw location string
  // itself ("Mumbai, India") wouldn't match REMOTE_RE.
  assert.equal(se?.isRemote, true);
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
