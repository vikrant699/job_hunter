// src/ats/tatacareers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tataCompanyName,
  tataSearchParams,
  parseTataPage,
  tataJobDetailUrl,
  normalizeTataCareers,
  BROAD_SEARCH_TERMS,
} from "../tatacareers.js";
import type { AdapterCompany } from "../../types.js";
import type { TataJob } from "../tatacareers.js";

const company: AdapterCompany = {
  provider: "tatacareers", slug: "tata-elxsi", name: "Tata Elxsi",
  careersUrl: "https://www.tata.com/careers/jobs/joblisting",
  tenantUrl: null, apiMeta: { company: "Tata Elxsi" },
};

const companyNoMeta: AdapterCompany = {
  provider: "tatacareers", slug: "no-meta", name: "No Meta Co",
  careersUrl: "https://www.tata.com/careers/jobs/joblisting",
  tenantUrl: null, apiMeta: null,
};

// Real shape captured live from POST /bin/tata/jobPostingsFilterServlet?
// (searchTerm=Developer, no company filter) — Tata Consultancy Services item.
const tcsJob: TataJob = {
  jobId: "411340",
  jobTitle: "DEVELOPER",
  companyName: "Tata Consultancy Services",
  location: "Kolkata, India",
  shortDescription:
    "Job Description Role : Java fullstack developer Must Have : java, springboot , node js, react js,java fullstack Desired Candidate Profile Qualifications :BACHELOR OF ENGINEERING",
  publishedDate: "May 11, 2026",
};

// Real shape captured live (companies=["Tejas Networks"]) — a "Flexible"
// location value, which the site's own location filter also uses to mean
// remote-friendly.
const flexibleJob: TataJob = {
  jobId: "290",
  jobTitle: "Senior Specialist",
  companyName: "Tejas Networks",
  location: "Flexible, United States",
  shortDescription: "Remote-friendly role supporting network fulfilment.",
  publishedDate: "Jun 20, 2026",
};

test("tataCompanyName reads apiMeta.company", () => {
  assert.equal(tataCompanyName(company), "Tata Elxsi");
});

test("tataCompanyName throws without apiMeta.company", () => {
  assert.throws(() => tataCompanyName(companyNoMeta), /apiMeta\.company/);
});

test("tataSearchParams builds the broad OR search + companies filter", () => {
  const params = tataSearchParams(company, 1);
  assert.equal(params.get("searchTerm"), BROAD_SEARCH_TERMS.join(", "));
  assert.equal(params.get("companies"), JSON.stringify(["Tata Elxsi"]));
  assert.equal(params.get("searchMode"), "search");
  assert.equal(params.get("start"), "1");
  assert.equal(params.get("filtersFlag"), null);
});

test("tataSearchParams marks continuation pages with filtersFlag=False", () => {
  const params = tataSearchParams(company, 11);
  assert.equal(params.get("start"), "11");
  assert.equal(params.get("filtersFlag"), "False");
});

test("parseTataPage unwraps jobPostings + totalJobPostingsCount", () => {
  const { jobs, total } = parseTataPage({
    response: { totalJobPostingsCount: 100, jobPostings: [tcsJob] },
  });
  assert.equal(total, 100);
  assert.deepEqual(jobs, [tcsJob]);
});

test("parseTataPage tolerates a missing jobPostings array", () => {
  const { jobs, total } = parseTataPage({ response: { totalJobPostingsCount: 0 } });
  assert.deepEqual(jobs, []);
  assert.equal(total, 0);
});

test("parseTataPage throws on a malformed envelope", () => {
  assert.throws(() => parseTataPage({ status: "Invalid input parameters/values" }));
});

test("tataJobDetailUrl matches the site's own link construction", () => {
  const url = tataJobDetailUrl(company, tcsJob);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://www.tata.com/careers/jobs/jobdetails");
  assert.equal(parsed.searchParams.get("jobId"), "411340");
  assert.equal(parsed.searchParams.get("company"), "Tata Elxsi");
  assert.equal(parsed.searchParams.get("jobTitle"), "DEVELOPER");
  assert.equal(parsed.searchParams.get("location"), "Kolkata, India");
});

test("normalizeTataCareers maps fields and parses the published date", () => {
  const p = normalizeTataCareers(company, tcsJob);
  assert.equal(p.provider, "tatacareers");
  assert.equal(p.externalId, "411340");
  assert.equal(p.companySlug, "tata-elxsi");
  assert.equal(p.companyName, "Tata Elxsi");
  assert.equal(p.jobTitle, "DEVELOPER");
  assert.equal(p.location, "Kolkata, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Java fullstack developer/);
  assert.equal(p.postedAt, new Date("May 11, 2026").toISOString());
});

test("normalizeTataCareers treats a 'Flexible, <country>' location as remote", () => {
  const p = normalizeTataCareers(company, flexibleJob);
  assert.equal(p.isRemote, true);
  assert.equal(p.location, "Flexible, United States");
});

test("normalizeTataCareers falls back to null postedAt for an unparsable date", () => {
  const p = normalizeTataCareers(company, { ...tcsJob, publishedDate: null });
  assert.equal(p.postedAt, null);
});

test("normalizeTataCareers falls back to null location when absent", () => {
  const p = normalizeTataCareers(company, { ...tcsJob, location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});
