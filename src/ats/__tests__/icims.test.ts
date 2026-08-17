// Pure-function coverage; the browser/WAF layer (Edge channel + page.request) is live-verified, not unit-tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  icimsSearchUrl,
  icimsTenant,
  parseIcimsList,
  parseIcimsJd,
} from "../icims.js";
import { at } from "./testHelpers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "icims",
  slug: "lennox",
  name: "Lennox India",
  careersUrl: "https://globalcareers-lennox.icims.com/jobs/search?ss=1",
  tenantUrl: "https://globalcareers-lennox.icims.com",
  apiMeta: null,
};

// One US dealer row, one India GCC row (IN-TN-Chennai), plus a franchisee-subdomain href.
const LIST_HTML = `<html><body><ul>
  <li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span > US-AZ-Tucson</span></div>
    <div class="col-xs-12 title"><a href="https://hrlydistribution-lennox.icims.com/jobs/54452/hvac-service-technician/job?in_iframe=1" class="iCIMS_Anchor" title="54452 - HVAC Service Technician"><span class="sr-only field-label">Title</span><h3 > HVAC Service Technician</h3></a></div>
  </div></li>
  <li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span > IN-TN-Chennai</span></div>
    <div class="col-xs-12 title"><a href="https://globalcareers-lennox.icims.com/jobs/54800/devops-engineer/job?mobile=false&in_iframe=1" class="iCIMS_Anchor" title="54800 - DevOps Engineer"><span class="sr-only field-label">Title</span><h3 > DevOps Engineer</h3></a></div>
  </div></li>
</ul></body></html>`;

// Real pages split the JD across several Expandable_Text sections.
const JD_HTML = `<html><body>
  <div class="iCIMS_JobHeader"><h1>DevOps Engineer</h1></div>
  <div class="iCIMS_JobContent">
    <div class="iCIMS_InfoMsg iCIMS_InfoField_Job">
      <div class="iCIMS_Expandable_Container"><div class="iCIMS_Expandable_Text">
        <p><strong>Overview</strong></p><p>Build <b>pipelines</b> for the Chennai GCC.</p>
      </div></div>
      <div class="iCIMS_Expandable_Container"><div class="iCIMS_Expandable_Text">
        <p><strong>Responsibilities</strong></p><p>Own CI/CD and observability.</p>
      </div></div>
    </div>
  </div>
</body></html>`;

test("icimsTenant reads the subdomain tenant token", () => {
  assert.equal(icimsTenant(company), "globalcareers-lennox");
  assert.throws(() => icimsTenant({ ...company, tenantUrl: null, careersUrl: "https://example.com" }), /icims/i);
});

test("icimsSearchUrl is 0-based and rides the in_iframe portal", () => {
  assert.equal(
    icimsSearchUrl("https://globalcareers-lennox.icims.com", 0),
    "https://globalcareers-lennox.icims.com/jobs/search?ss=1&in_iframe=1&pr=0",
  );
  assert.equal(
    icimsSearchUrl("https://globalcareers-lennox.icims.com", 3),
    "https://globalcareers-lennox.icims.com/jobs/search?ss=1&in_iframe=1&pr=3",
  );
});

test("parseIcimsList extracts id, title, location and a cleaned canonical link", () => {
  const jobs = parseIcimsList(LIST_HTML, company);
  assert.equal(jobs.length, 2);
  const j0 = at(jobs, 0);
  assert.equal(j0.provider, "icims");
  assert.equal(j0.externalId, "54452");
  assert.equal(j0.jobTitle, "HVAC Service Technician");
  assert.equal(j0.location, "US-AZ-Tucson");
  // canonical link keeps the franchisee subdomain, strips the ?in_iframe query
  assert.equal(j0.jobUrl, "https://hrlydistribution-lennox.icims.com/jobs/54452/hvac-service-technician/job");
  assert.equal(j0.jdText, ""); // filled by fetchJd
  const j1 = at(jobs, 1);
  assert.equal(j1.externalId, "54800");
  assert.equal(j1.location, "IN-TN-Chennai");
  assert.equal(j1.jobUrl, "https://globalcareers-lennox.icims.com/jobs/54800/devops-engineer/job");
});

test("parseIcimsJd concatenates all expandable sections (not just the first)", () => {
  const jd = parseIcimsJd(JD_HTML);
  assert.match(jd, /Overview/);
  assert.match(jd, /Build pipelines for the Chennai GCC\./);
  // The second section must be present - the bug was stopping at the first.
  assert.match(jd, /Responsibilities/);
  assert.match(jd, /Own CI\/CD and observability\./);
});

test("parseIcimsJd returns empty string when no content block is present", () => {
  assert.equal(parseIcimsJd("<html><body><div>nothing</div></body></html>"), "");
});
