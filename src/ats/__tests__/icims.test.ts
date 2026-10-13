// Pure-function coverage; the browser/WAF layer (Edge channel + page.request) is live-verified, not unit-tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  icimsPageCount,
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
  assert.equal(j1.location, "IN-TN-Chennai, India");
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

// DocuSign-style card: the header slot holds the Job ID; the location sits in the additionalFields dl.
const DL_CARD_HTML = `<html><body><ul>
  <li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Job ID</span><span > 2026-30533</span></div>
    <div class="col-xs-12 title"><a href="https://indiacareers-docusign.icims.com/jobs/30533/senior-manager%2c-partner-solution-architect/job?in_iframe=1" class="iCIMS_Anchor"><span class="sr-only field-label">External Title</span><h3 > Senior Manager, Partner Solution Architect</h3></a></div>
    <div class="col-xs-12 additionalFields"><dl class="iCIMS_JobHeaderGroup">
      <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField"><span class="glyphicons glyphicons-map-marker"></span><span class="sr-only field-label">Job Locations</span></dt><dd class="iCIMS_JobHeaderData"><span > IN-KA-Bengaluru</span></dd></div>
      <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Category</dt><dd class="iCIMS_JobHeaderData"><span > Sales</span></dd></div>
    </dl></div>
  </div></li>
  <li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Job ID</span><span > 2026-30453</span></div>
    <div class="col-xs-12 title"><a href="https://indiacareers-docusign.icims.com/jobs/30453/ai-engineer/job?in_iframe=1" class="iCIMS_Anchor"><h3 > AI Engineer</h3></a></div>
  </div></li>
</ul></body></html>`;

test("parseIcimsList reads the labelled Job Locations field, never the Job ID header slot", () => {
  const jobs = parseIcimsList(DL_CARD_HTML, company);
  assert.equal(jobs.length, 2);
  assert.equal(at(jobs, 0).externalId, "30533");
  assert.equal(at(jobs, 0).location, "IN-KA-Bengaluru, India");
  assert.equal(at(jobs, 1).location, null);
});

test("icimsPageCount reads the portal's Page X of N header", () => {
  assert.equal(icimsPageCount(`<h2 class="iCIMS_SubHeader iCIMS_SubHeader_Jobs">\nSearch Results\nPage 2 of 24 \n</h2>`), 24);
  assert.equal(icimsPageCount(`<h2 class="iCIMS_SubHeader iCIMS_SubHeader_Jobs">Search Results Page 1 of 1</h2>`), 1);
  assert.equal(icimsPageCount("<html><body>no header</body></html>"), null);
});

test("parseIcimsList spells out India on IN-coded locations so bare-town GCC postings stay in region", () => {
  const html = LIST_HTML.replace("IN-TN-Chennai", "US-TX-Irving | IN-Chennai");
  const jobs = parseIcimsList(html, company);
  assert.equal(at(jobs, 1).location, "US-TX-Irving | IN-Chennai, India");
  assert.equal(at(jobs, 0).location, "US-AZ-Tucson");
});

test("parseIcimsList joins a 'Location' header label with 'Additional Locations' (Kinaxis layout)", () => {
  const html = `<ul><li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Location</span><span > CA-ON-Toronto</span></div>
    <div class="col-xs-6 header right"><span class="sr-only field-label">ID</span><span > 2026-35517</span></div>
    <div class="col-xs-12 title"><a href="https://careers-kinaxis.icims.com/jobs/35517/risk-intern/job?in_iframe=1" class="iCIMS_Anchor"><h3 > Risk Intern</h3></a></div>
    <div class="col-xs-12 additionalFields"><dl class="iCIMS_JobHeaderGroup">
      <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Category</dt><dd class="iCIMS_JobHeaderData"><span > Legal</span></dd></div>
      <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField"><span class="sr-only field-label">Additional Locations</span></dt><dd class="iCIMS_JobHeaderData"><span > IN-TN-Chennai</span></dd></div>
    </dl></div>
  </div></li></ul>`;
  assert.equal(at(parseIcimsList(html, company), 0).location, "CA-ON-Toronto | IN-TN-Chennai, India");
});

test("parseIcimsList reads a 'Location : Location' label and the 3-letter IND code (MaxLinear layout)", () => {
  const html = `<ul><li class="iCIMS_JobCardItem"><div class="row">
    <div class="col-xs-6 header left"><span class="sr-only field-label">Location : Location</span><span > IND-KA-Bangalore</span></div>
    <div class="col-xs-12 title"><a href="https://careersintl-maxlinear.icims.com/jobs/3085/dsp-fw/job?in_iframe=1" class="iCIMS_Anchor"><h3 > DSP FW</h3></a></div>
    <div class="col-xs-12 additionalFields"><dl class="iCIMS_JobHeaderGroup">
      <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">ID</dt><dd class="iCIMS_JobHeaderData"><span > 2026-3085</span></dd></div>
    </dl></div>
  </div></li></ul>`;
  assert.equal(at(parseIcimsList(html, company), 0).location, "IND-KA-Bangalore, India");
});
