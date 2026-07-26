import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJobsIsland,
  parseJobsIsland,
  postingsFromZohoHtml,
  zohoJobUrl,
  ZohoRecruitJobSchema,
  type ZohoRecruitJob,
} from "./zohorecruit.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "zohorecruit",
  slug: "acowale",
  name: "Acowale",
  careersUrl: "https://acowale.zohorecruit.in/jobs/Careers",
  tenantUrl: null,
  apiMeta: null,
};

// Escape a string the way Zoho serializes the hidden-input value attribute:
// every HTML-special character becomes an entity (& first so it isn't double-hit).
function attrEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Trimmed real shape from https://acowale.zohorecruit.in/jobs/Careers.
const fullJob = {
  Remote_Job: false,
  Posting_Title: "Frontend Developer",
  Is_Locked: false,
  City: "Bangalore South",
  Industry: "Computer",
  Job_Description: '<p>Build UIs with React &amp; TypeScript. "Pixel-perfect" work.</p>',
  Work_Experience: "1-3 years",
  Job_Type: "Full time",
  Job_Opening_Name: "Frontend Developer",
  State: "Karnataka",
  Country: "India",
  id: "196319000004222912",
  Publish: true,
  Date_Opened: "2026-06-29",
  Keep_on_Career_Site: false,
};

const remoteJob = {
  Remote_Job: true,
  Posting_Title: "Full-Stack Developer Internship - Unpaid",
  Job_Description: "Ship features end to end.",
  id: "196319000004222727",
  Publish: true,
};

/** Wrap a jobs array in a realistic careers page: junk around the island plus
 *  the sibling hidden inputs (moduleMeta before, portal config after). */
function pageWith(jobs: ReadonlyArray<Record<string, boolean | string>>): string {
  const meta = attrEscape('[{"api_name":"Posting_Title","field_label":"Posting Title"}]');
  const cfg = attrEscape('{"source":"CareerSite","org_info":{"company_name":"Acowale"}}');
  return [
    "<!DOCTYPE html><html><head><title>Careers</title></head><body>",
    '<script>var lyteReady = "id=\\"jobs\\" is rendered later";</script>',
    `<input type="hidden" value="${meta}" id="moduleMeta">`,
    // data-value sits BEFORE value: the old \bvalue= regex would grab "EVIL".
    `<input type="hidden" data-value="EVIL" value="${attrEscape(JSON.stringify(jobs))}" id="jobs">`,
    `<input type="hidden" value="${cfg}" id="portalDetails">`,
    "</body></html>",
  ].join("");
}

test("extractJobsIsland finds the id=\"jobs\" input among sibling islands", () => {
  const raw = extractJobsIsland(pageWith([fullJob, remoteJob]));
  assert.ok(raw !== null);
  assert.match(raw!, /^\[\{&#34;/); // still entity-escaped at this point
});

test("extractJobsIsland skips raw id=\"jobs\" literals in earlier page content", () => {
  // Raw (NOT JS-escaped) literals before the real island: one in a CSS
  // selector inside a <style> block, one in a <div> attribute, and one inside
  // an earlier <input> tag that has no value attribute.
  const decoys = [
    '<style>.board input[id="jobs"] { display: none; }</style>',
    "<div data-target='id=\"jobs\"' class=\"lyte-placeholder\">loading…</div>",
    '<input type="checkbox" id="jobs">',
  ].join("");
  const html = pageWith([fullJob]).replace("<body>", `<body>${decoys}`);
  const jobs = parseJobsIsland(extractJobsIsland(html)!, company.slug);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.id, "196319000004222912");
});

test("extractJobsIsland returns null when the island is absent", () => {
  assert.equal(extractJobsIsland("<html><body>no board here</body></html>"), null);
  assert.equal(extractJobsIsland(""), null);
});

test("parseJobsIsland decodes, JSON-parses, and zod-validates the jobs array", () => {
  const raw = extractJobsIsland(pageWith([fullJob, remoteJob]));
  const jobs = parseJobsIsland(raw!, company.slug);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.Posting_Title, "Frontend Developer");
  assert.equal(jobs[0]!.id, "196319000004222912");
  // The JD survives both unescaping layers: attribute entities -> JSON string
  // -> HTML (left intact here; normalize strips it).
  assert.match(jobs[0]!.Job_Description!, /<p>Build UIs with React &amp; TypeScript\./);
  assert.equal(jobs[1]!.Remote_Job, true);
});

test("parseJobsIsland throws an actionable error on non-JSON garbage", () => {
  assert.throws(
    () => parseJobsIsland("not json at all", "acowale"),
    /zohorecruit jobs island is not valid JSON for acowale/,
  );
});

test("parseJobsIsland throws an actionable error when the shape is wrong", () => {
  // id must be a string; a numeric id means Zoho changed the serialization.
  const bad = attrEscape(JSON.stringify([{ Posting_Title: "X", id: 42 }]));
  assert.throws(
    () => parseJobsIsland(bad, "acowale"),
    /zohorecruit jobs island response failed schema for acowale/,
  );
});

test("ZohoRecruitJobSchema tolerates missing optionals but requires id+title", () => {
  assert.ok(ZohoRecruitJobSchema.safeParse({ id: "1", Posting_Title: "T" }).success);
  assert.equal(ZohoRecruitJobSchema.safeParse({ id: "1" }).success, false);
  assert.equal(ZohoRecruitJobSchema.safeParse({ Posting_Title: "T" }).success, false);
});

test("postingsFromZohoHtml maps fields onto NormalizedPosting", () => {
  const [p, r] = postingsFromZohoHtml(company, pageWith([fullJob, remoteJob]));
  assert.equal(p!.provider, "zohorecruit");
  assert.equal(p!.externalId, "196319000004222912");
  assert.equal(p!.companySlug, "acowale");
  assert.equal(p!.companyName, "Acowale");
  assert.equal(p!.jobTitle, "Frontend Developer");
  assert.equal(p!.jobUrl, "https://acowale.zohorecruit.in/jobs/Careers/196319000004222912/Frontend-Developer");
  assert.equal(p!.location, "Bangalore South, Karnataka, India");
  assert.equal(p!.isRemote, false);
  assert.equal(p!.postedAt, "2026-06-29");
  // JD is plain text: HTML stripped, inner entities decoded.
  assert.match(p!.jdText, /Build UIs with React & TypeScript\. "Pixel-perfect" work\./);
  assert.doesNotMatch(p!.jdText, /<p>/);

  assert.equal(r!.isRemote, true);
  assert.equal(r!.location, null); // no City/State/Country on the fixture
  assert.equal(r!.postedAt, null);
  assert.equal(
    r!.jobUrl,
    "https://acowale.zohorecruit.in/jobs/Careers/196319000004222727/Full-Stack-Developer-Internship-Unpaid",
  );
});

test("postingsFromZohoHtml drops jobs explicitly marked Publish:false", () => {
  const unpublished = { ...remoteJob, id: "196319000000000001", Publish: false };
  const out = postingsFromZohoHtml(company, pageWith([fullJob, unpublished]));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.externalId, "196319000004222912");
});

test("postingsFromZohoHtml returns [] for an empty board (value=\"[]\")", () => {
  assert.deepEqual(postingsFromZohoHtml(company, pageWith([])), []);
});

test("postingsFromZohoHtml throws when the island is missing entirely", () => {
  assert.throws(
    () => postingsFromZohoHtml(company, "<html><body>WAF interstitial</body></html>"),
    /zohorecruit: no id="jobs" island/,
  );
});

test("zohoJobUrl tolerates trailing slashes and unslugifiable titles", () => {
  const c: AdapterCompany = { ...company, careersUrl: "https://spendflo.zohorecruit.com/jobs/Job-openings/" };
  const j: ZohoRecruitJob = { id: "9", Posting_Title: "SDE II (Platform) @ Chennai" };
  assert.equal(zohoJobUrl(c, j), "https://spendflo.zohorecruit.com/jobs/Job-openings/9/SDE-II-Platform-Chennai");
  const weird: ZohoRecruitJob = { id: "9", Posting_Title: "???" };
  assert.equal(zohoJobUrl(c, weird), "https://spendflo.zohorecruit.com/jobs/Job-openings/9");
});
