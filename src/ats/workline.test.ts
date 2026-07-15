// src/ats/workline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  worklineListUrl,
  worklineDetailUrl,
  worklineRootUrl,
  worklinePdfUrl,
  parseWorklineListEnvelope,
  worklineLocation,
  parseWorklinePublishDate,
  normalizeWorklineJob,
  extractWorklineDetailJd,
  extractWorklineHiddenPdfFilename,
  composeWorklineFallbackJd,
  worklineFallbackInputFromJob,
  type WorklineJob,
} from "./workline.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "workline",
  slug: "bluestar",
  name: "Blue Star Limited",
  careersUrl: "https://bluestar.workline.hr/CPortal/generalopening.aspx",
  tenantUrl: null,
  apiMeta: null,
};

const baseJob: WorklineJob = {
  Req_No: "12913",
  Position_Name: "FEA Engineer",
  PublishDate: "14-Jul-2026",
  No_Of_Vacancies: 1,
  business_name: "Blue Star Limited",
  Company_Name: "Centre of Excellence",
  JobSpecificationFile: "1027202604271920028_JD_FEA_M3_M4.pdf",
  MRFDetailFile: "12913_2026Jul140617.pdf",
  City_Name: "Thane",
  LOCATIONNAME: "Thane",
  LOCATIONNAME1: "Thane",
  State: "Maharashtra",
  state_name: "Maharashtra",
  Country_Name: "India",
  TrackToken: "b04114b8-05c3-4863-afc8-57c0f27a1679",
  SearchKeyWord: "FEA-Engineer-Job-in-Thane-22105",
};

// --- URL builders ------------------------------------------------------------

test("worklineListUrl builds the tenant's GetCurrentopening WebMethod URL", () => {
  assert.equal(
    worklineListUrl("bluestar"),
    "https://bluestar.workline.hr/CPortal/generalopening.aspx/GetCurrentopening",
  );
});

test("worklineDetailUrl builds a TrackToken/SearchKeyWord-keyed detail URL, encoding the keyword", () => {
  assert.equal(
    worklineDetailUrl("bluestar", "b04114b8-05c3-4863-afc8-57c0f27a1679", "FEA-Engineer-Job-in-Thane-22105"),
    "https://bluestar.workline.hr/CandidatePortal/b04114b8-05c3-4863-afc8-57c0f27a1679/FEA-Engineer-Job-in-Thane-22105",
  );
  assert.equal(
    worklineDetailUrl("bluestar", "tok", "Sales Executive - Channel Sales"),
    "https://bluestar.workline.hr/CandidatePortal/tok/Sales%20Executive%20-%20Channel%20Sales",
  );
});

test("worklineRootUrl builds the bare tenant origin", () => {
  assert.equal(worklineRootUrl("bluestar"), "https://bluestar.workline.hr/");
});

test("worklinePdfUrl builds the CanPRFApply viewer URL, encoding the filename", () => {
  assert.equal(
    worklinePdfUrl("bluestar", "1027202604271920028_JD_FEA_M3_M4.pdf"),
    "https://bluestar.workline.hr/CPortal/CanPRFApply.aspx?ModeFlag=V&filename=1027202604271920028_JD_FEA_M3_M4.pdf",
  );
});

// --- parseWorklineListEnvelope -----------------------------------------------

test("parseWorklineListEnvelope JSON.parses the double-encoded d.obj1 string and validates rows", () => {
  const envelope = {
    d: {
      __type: "CurrentOpeningData",
      obj1: JSON.stringify([baseJob, { ...baseJob, Req_No: "13423", Position_Name: "Project Construction Engineer" }]),
      obj2: "[]",
    },
  };
  const jobs = parseWorklineListEnvelope(envelope);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.Req_No, "12913");
  assert.equal(jobs[1]!.Position_Name, "Project Construction Engineer");
});

test("parseWorklineListEnvelope throws when the envelope shape is wrong", () => {
  assert.throws(() => parseWorklineListEnvelope({ notD: {} }), /envelope failed schema/);
});

test("parseWorklineListEnvelope throws when d.obj1 isn't valid JSON", () => {
  assert.throws(() => parseWorklineListEnvelope({ d: { obj1: "not json" } }), /not valid JSON/);
});

test("parseWorklineListEnvelope throws when a row fails schema (missing Position_Name)", () => {
  const envelope = { d: { obj1: JSON.stringify([{ Req_No: "1" }]) } };
  assert.throws(() => parseWorklineListEnvelope(envelope), /rows failed schema/);
});

// --- worklineLocation ---------------------------------------------------------

test("worklineLocation composes City, State, Country from LOCATIONNAME/State/Country_Name", () => {
  assert.equal(worklineLocation(baseJob), "Thane, Maharashtra, India");
});

test("worklineLocation prefers LOCATIONNAME over a stale City_Name", () => {
  const job: WorklineJob = { ...baseJob, City_Name: "Kolkata", LOCATIONNAME: "Guwahati", LOCATIONNAME1: "Guwahati" };
  assert.equal(worklineLocation(job), "Guwahati, Maharashtra, India");
});

test("worklineLocation falls back to City_Name when LOCATIONNAME fields are absent", () => {
  const job: WorklineJob = { ...baseJob, LOCATIONNAME: null, LOCATIONNAME1: null, City_Name: "Pune" };
  assert.equal(worklineLocation(job), "Pune, Maharashtra, India");
});

test("worklineLocation returns null when no location fields are present", () => {
  const job: WorklineJob = {
    ...baseJob,
    City_Name: null,
    LOCATIONNAME: null,
    LOCATIONNAME1: null,
    State: null,
    state_name: null,
    Country_Name: null,
  };
  assert.equal(worklineLocation(job), null);
});

// --- parseWorklinePublishDate --------------------------------------------------

test("parseWorklinePublishDate converts DD-Mon-YYYY to ISO", () => {
  assert.equal(parseWorklinePublishDate("14-Jul-2026"), new Date(Date.UTC(2026, 6, 14)).toISOString());
});

test("parseWorklinePublishDate returns null on absent/unparseable input", () => {
  assert.equal(parseWorklinePublishDate(null), null);
  assert.equal(parseWorklinePublishDate(undefined), null);
  assert.equal(parseWorklinePublishDate("2026-07-14"), null);
  assert.equal(parseWorklinePublishDate("garbage"), null);
});

// --- normalizeWorklineJob -----------------------------------------------------

test("normalizeWorklineJob maps fields correctly", () => {
  const p = normalizeWorklineJob(company, baseJob);
  assert.equal(p.provider, "workline");
  assert.equal(p.externalId, "12913");
  assert.equal(p.companySlug, "bluestar");
  assert.equal(p.companyName, "Blue Star Limited");
  assert.equal(p.jobTitle, "FEA Engineer");
  assert.equal(
    p.jobUrl,
    "https://bluestar.workline.hr/CandidatePortal/b04114b8-05c3-4863-afc8-57c0f27a1679/FEA-Engineer-Job-in-Thane-22105",
  );
  assert.equal(p.location, "Thane, Maharashtra, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date(Date.UTC(2026, 6, 14)).toISOString());
});

test("normalizeWorklineJob falls back to the root tenant URL when TrackToken/SearchKeyWord are missing", () => {
  const job: WorklineJob = { ...baseJob, TrackToken: null, SearchKeyWord: null };
  const p = normalizeWorklineJob(company, job);
  assert.equal(p.jobUrl, "https://bluestar.workline.hr/");
});

test("normalizeWorklineJob flags isRemote from a REMOTE_RE-matching location", () => {
  const job: WorklineJob = { ...baseJob, LOCATIONNAME: "Remote", LOCATIONNAME1: "Remote", City_Name: "Remote" };
  const p = normalizeWorklineJob(company, job);
  assert.equal(p.isRemote, true);
});

test("normalizeWorklineJob coerces a numeric Req_No to a string externalId", () => {
  const job: WorklineJob = { ...baseJob, Req_No: 12913 };
  assert.equal(normalizeWorklineJob(company, job).externalId, "12913");
});

// --- extractWorklineDetailJd ----------------------------------------------------

const detailHtml = `
<div class="job-details-info">
  <div class="jobs-wrapper">
    <div class="description-info">
      <h4> <strong>Job Description</strong></h4>
      <p>Responsible for performing start-to-end simulations inside ANSYS workbench.<Br>Responsible for collecting input data.</p>
    </div>
    <div class="requirements">
      <input type="hidden" id="hideJobSpecificationFile" name="hideJobSpecificationFile" value="1027202604271920028_JD_FEA_M3_M4.pdf" />
      <div id="viewer"></div>
    </div>
  </div>
  <div class="jobs-wrapper job-short-info">
    <ul>
      <li><span class="icon"></span>Posted: 1 day(s) ago</li>
      <li><span class="icon"></span> Location: Thane</li>
      <li><span class="icon"></span>Qualifications: Master's degree in Mechanical / Aerospace / Structural.</li>
      <li><span class="icon"></span>Experience: 0 Years - 0 Months To 4 Years - 0 Months</li>
    </ul>
  </div>
</div>`;

test("extractWorklineDetailJd pulls description + qualifications + experience and strips HTML", () => {
  const jd = extractWorklineDetailJd(detailHtml);
  assert.match(jd, /start-to-end simulations inside ANSYS workbench/);
  assert.match(jd, /Master's degree in Mechanical/);
  assert.match(jd, /0 Years - 0 Months To 4 Years - 0 Months/);
  assert.doesNotMatch(jd, /<p>|<div>|<li>/);
});

test("extractWorklineDetailJd returns empty string when no description block is present", () => {
  assert.equal(extractWorklineDetailJd("<html><body>no jd blocks here</body></html>"), "");
});

// --- extractWorklineHiddenPdfFilename --------------------------------------------

test("extractWorklineHiddenPdfFilename reads the hidden input's value", () => {
  assert.equal(extractWorklineHiddenPdfFilename(detailHtml), "1027202604271920028_JD_FEA_M3_M4.pdf");
});

test("extractWorklineHiddenPdfFilename returns null when the hidden input isn't rendered", () => {
  assert.equal(extractWorklineHiddenPdfFilename("<html><body>no hidden field</body></html>"), null);
});

// --- composeWorklineFallbackJd / worklineFallbackInputFromJob -----------------------

test("composeWorklineFallbackJd builds non-empty deterministic text with all fields present", () => {
  const jd = composeWorklineFallbackJd({
    jobTitle: "FEA Engineer",
    business: "Centre of Excellence",
    location: "Thane, Maharashtra, India",
    vacancies: 1,
    pdfUrl: "https://bluestar.workline.hr/CPortal/CanPRFApply.aspx?ModeFlag=V&filename=jd.pdf",
  });
  assert.match(jd, /^FEA Engineer/);
  assert.match(jd, /Business: Centre of Excellence/);
  assert.match(jd, /Location: Thane, Maharashtra, India/);
  assert.match(jd, /Vacancies: 1/);
  assert.match(jd, /Full JD: https:\/\/bluestar\.workline\.hr\/CPortal\/CanPRFApply\.aspx\?ModeFlag=V&filename=jd\.pdf/);
});

test("composeWorklineFallbackJd omits the Full JD line when no pdfUrl is available, but stays non-empty", () => {
  const jd = composeWorklineFallbackJd({
    jobTitle: "Sales Executive",
    business: null,
    location: null,
    vacancies: null,
    pdfUrl: null,
  });
  assert.ok(jd.length > 0);
  assert.match(jd, /^Sales Executive/);
  assert.match(jd, /Business: n\/a/);
  assert.match(jd, /Location: n\/a/);
  assert.match(jd, /Vacancies: n\/a/);
  assert.doesNotMatch(jd, /Full JD:/);
});

test("worklineFallbackInputFromJob builds the fallback input from a raw listing row", () => {
  const input = worklineFallbackInputFromJob(baseJob, "bluestar");
  assert.equal(input.jobTitle, "FEA Engineer");
  assert.equal(input.business, "Centre of Excellence");
  assert.equal(input.location, "Thane, Maharashtra, India");
  assert.equal(input.vacancies, 1);
  assert.equal(
    input.pdfUrl,
    "https://bluestar.workline.hr/CPortal/CanPRFApply.aspx?ModeFlag=V&filename=1027202604271920028_JD_FEA_M3_M4.pdf",
  );
});

test("worklineFallbackInputFromJob falls back to MRFDetailFile when JobSpecificationFile is empty", () => {
  const job: WorklineJob = { ...baseJob, JobSpecificationFile: "" };
  const input = worklineFallbackInputFromJob(job, "bluestar");
  assert.equal(
    input.pdfUrl,
    "https://bluestar.workline.hr/CPortal/CanPRFApply.aspx?ModeFlag=V&filename=12913_2026Jul140617.pdf",
  );
});

test("worklineFallbackInputFromJob falls back to business_name when Company_Name is absent, and null pdfUrl when neither file is present", () => {
  const job: WorklineJob = { ...baseJob, Company_Name: null, JobSpecificationFile: "", MRFDetailFile: "" };
  const input = worklineFallbackInputFromJob(job, "bluestar");
  assert.equal(input.business, "Blue Star Limited");
  assert.equal(input.pdfUrl, null);
});

// composeWorklineFallbackJd(worklineFallbackInputFromJob(...)) end-to-end, matching
// the literal field list this fallback was speced against (Position_Name, Business,
// location, No_Of_Vacancies, "Full JD: <pdf url>").
test("composeWorklineFallbackJd(worklineFallbackInputFromJob(job)) yields non-empty text with every field", () => {
  const jd = composeWorklineFallbackJd(worklineFallbackInputFromJob(baseJob, "bluestar"));
  assert.match(jd, /FEA Engineer/);
  assert.match(jd, /Business: Centre of Excellence/);
  assert.match(jd, /Location: Thane, Maharashtra, India/);
  assert.match(jd, /Vacancies: 1/);
  assert.match(jd, /Full JD: https:\/\/bluestar\.workline\.hr\/CPortal\/CanPRFApply\.aspx/);
});
