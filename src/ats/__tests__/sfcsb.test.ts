import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sfcsbAdapter,
  sfcsbSearchBody,
  sfcsbJobUrl,
  parseSfcsbPage,
  parseSfcsbJd,
} from "../sfcsb.js";
import { at, asJson, fetchSequence, htmlResponse, jsonResponse, stubFetch } from "./testHelpers.js";
import { captureLogs } from "../../__tests__/logCapture.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";

const company: AdapterCompany = {
  provider: "sfcsb",
  slug: "tuv-sud",
  name: "TUV SUD India",
  careersUrl: "https://jobs.tuvsud.com",
  tenantUrl: "https://jobs.tuvsud.com",
  apiMeta: null,
};

const PAGE1 = {
  totalJobs: 3,
  jobSearchResult: [
    {
      response: {
        id: "5161",
        unifiedStandardTitle: "QA Engineer",
        urlTitle: "QA-Engineer",
        jobLocationShort: ["India, Mahārāshtra, Pune ", "India, Mahārāshtra, Mumbai "],
        unifiedStandardStart: "4/16/26",
      },
    },
    {
      response: {
        id: "4262",
        unifiedStandardTitle: "Field Auditor (Remote)",
        urlTitle: "Field-Auditor",
        custprimecity: "Noida",
        custCountryRegion: ["India"],
        unifiedStandardStart: "5/1/26",
      },
    },
  ],
};
const PAGE2 = {
  totalJobs: 3,
  jobSearchResult: [
    { response: { id: "4644", unifiedStandardTitle: "Webinar Manager", jobLocationShort: ["Germany, Bavaria, Munich "], unifiedStandardStart: "3/2/26" } },
  ],
};

const JD_HTML = `<html><body>
  <meta itemprop="description" content="ignore me"/>
  <div><span itemprop="description" class="rtltextaligneligible">   </span></div>
  <div><span itemprop="description" class="rtltextaligneligible"><p><strong>Responsibilities</strong></p><p>Test the <b>widgets</b>.</p></span></div>
</body></html>`;

test("sfcsbSearchBody is 0-based, date-sorted, with empty keywords", () => {
  assert.deepEqual(sfcsbSearchBody(0), { keywords: "", locale: "en_US", pageNumber: 0, sortBy: "date" });
  assert.deepEqual(sfcsbSearchBody(3), { keywords: "", locale: "en_US", pageNumber: 3, sortBy: "date" });
});

test("sfcsbJobUrl builds the canonical <host>/job/<slug>/<id>-en_US/ link", () => {
  assert.equal(sfcsbJobUrl(company, "5161", "QA-Engineer"), "https://jobs.tuvsud.com/job/QA-Engineer/5161-en_US/");
  assert.equal(sfcsbJobUrl(company, "5161", null), "https://jobs.tuvsud.com/job/x/5161-en_US/");
});

test("parseSfcsbPage maps both location shapes and the total", () => {
  const { jobs, total } = parseSfcsbPage(asJson(PAGE1), company);
  assert.equal(total, 3);
  assert.equal(jobs.length, 2);
  const j0 = at(jobs, 0);
  assert.equal(j0.provider, "sfcsb");
  assert.equal(j0.externalId, "5161");
  assert.equal(j0.jobTitle, "QA Engineer");
  assert.equal(j0.jobUrl, "https://jobs.tuvsud.com/job/QA-Engineer/5161-en_US/");
  assert.equal(j0.location, "India, Mahārāshtra, Pune; India, Mahārāshtra, Mumbai");
  assert.equal(j0.isRemote, false);
  assert.equal(j0.jdText, "");
  assert.equal(at(jobs, 1).location, "Noida, India");
  assert.equal(at(jobs, 1).isRemote, true);
});

test("parseSfcsbJd picks the richest itemprop=description span", () => {
  const jd = parseSfcsbJd(JD_HTML);
  assert.match(jd, /Responsibilities/);
  assert.match(jd, /Test the widgets\./);
});

test("listPostings paginates by 0-based pageNumber to totalJobs, always date-sorted", async (t) => {
  const seen: number[] = [];
  stubFetch(t, (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (String(input).endsWith("/services/recruiting/v1/jobs")) assert.match(body, /"sortBy":"date"/);
    const m = /"pageNumber":(\d+)/.exec(body);
    const page = m ? Number(m[1]) : -1;
    seen.push(page);
    return Promise.resolve(jsonResponse(page === 0 ? PAGE1 : PAGE2));
  });
  const postings = await sfcsbAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  assert.deepEqual(seen.slice(0, 2), [0, 1]);
});

test("fetchJd fetches the canonical page and extracts the JD", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(JD_HTML)));
  const posting = at(parseSfcsbPage(asJson(PAGE1), company).jobs, 0);
  const jd = await sfcsbAdapter.fetchJd?.(company, posting);
  assert.match(jd ?? "", /Test the widgets\./);
});

test("an alive-but-empty tenant (totalJobs 0, no result array) yields nothing", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ totalJobs: 0 })));
  const postings = await sfcsbAdapter.listPostings(company);
  assert.equal(postings.length, 0);
});

test("sfcsbSearchBody honors a locale override (indegene needs en_GB)", () => {
  assert.deepEqual(sfcsbSearchBody(2, "en_GB"), { keywords: "", locale: "en_GB", pageNumber: 2, sortBy: "date" });
  assert.deepEqual(sfcsbSearchBody(1), { keywords: "", locale: "en_US", pageNumber: 1, sortBy: "date" });
});

test("listPostings gap-fills a sitemap id the JSON API missed, keeping the API-returned titles and locations", async (t) => {
  const SITEMAP_XML = `<urlset>
    <url><loc>https://jobs.tuvsud.com/job/QA-Engineer/5161/</loc></url>
    <url><loc>https://jobs.tuvsud.com/job/Field-Auditor/4262/</loc></url>
    <url><loc>https://jobs.tuvsud.com/job/Extra-Sitemap-Only-Role/9999/</loc></url>
  </urlset>`;
  stubFetch(t, (input, init) => {
    const url = String(input);
    if (url === "https://jobs.tuvsud.com/sitemap.xml") return Promise.resolve(htmlResponse(SITEMAP_XML));
    const body = typeof init?.body === "string" ? init.body : "";
    const m = /"pageNumber":(\d+)/.exec(body);
    const page = m ? Number(m[1]) : -1;
    return Promise.resolve(jsonResponse(page === 0 ? { totalJobs: 2, jobSearchResult: PAGE1.jobSearchResult } : { totalJobs: 2, jobSearchResult: [] }));
  });
  const postings = await sfcsbAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  const extra = postings.find((p) => p.externalId === "9999");
  assert.ok(extra);
  assert.equal(extra.jobUrl, "https://jobs.tuvsud.com/job/Extra-Sitemap-Only-Role/9999/");
  assert.equal(extra.jobTitle, "Extra Sitemap Only Role");
  assert.equal(extra.location, null);
  assert.equal(extra.jdText, "");
  // API ids share the sitemap's req-id space, so the sitemap URL is the canonical page; title/location stay API-sourced.
  const apiJob = postings.find((p) => p.externalId === "5161");
  assert.ok(apiJob);
  assert.equal(apiJob.jobUrl, "https://jobs.tuvsud.com/job/QA-Engineer/5161/");
  assert.equal(apiJob.jobTitle, "QA Engineer");
  assert.equal(apiJob.location, "India, Mahārāshtra, Pune; India, Mahārāshtra, Mumbai");
});

function stubCsb(t: Parameters<typeof stubFetch>[0], sitemapXml: string, pages: ReadonlyArray<typeof PAGE1>): void {
  stubFetch(t, (input, init) => {
    if (String(input).endsWith("/sitemap.xml")) return Promise.resolve(htmlResponse(sitemapXml));
    const body = typeof init?.body === "string" ? init.body : "";
    const m = /"pageNumber":(\d+)/.exec(body);
    const page = pages[m ? Number(m[1]) : -1];
    return Promise.resolve(jsonResponse(page ?? { totalJobs: 0, jobSearchResult: [] }));
  });
}

test("listPostings skips the gap-fill when the sitemap's req ids share nothing with the API's CSB ids (same jobs, other id space)", async (t) => {
  // tuv-sud shape: the sitemap addresses every job by its jobs2web req id, which redirects to the CSB <id>-<locale> page.
  stubCsb(t, `<urlset>
    <url><loc>https://jobs.tuvsud.com/job/Pune-QA-Engineer-MH/1350177555/</loc></url>
    <url><loc>https://jobs.tuvsud.com/job/Noida-Field-Auditor-UP/1350177655/</loc></url>
    <url><loc>https://jobs.tuvsud.com/job/M%C3%BCnchen-Pr%C3%BCfer-BY/1350177755/</loc></url>
  </urlset>`, [{ totalJobs: 2, jobSearchResult: PAGE1.jobSearchResult }]);
  let postings: NormalizedPosting[] = [];
  const lines = await captureLogs(async () => {
    postings = await sfcsbAdapter.listPostings(company);
  });
  assert.deepEqual(postings.map((p) => p.externalId).sort(), ["4262", "5161"]);
  assert.equal(at(postings, 0).jobUrl, "https://jobs.tuvsud.com/job/QA-Engineer/5161-en_US/");
  assert.ok(lines.some((l) => /different id space/.test(l.message ?? "")));
  assert.ok(!lines.some((l) => l.level === "warn"));
});

test("listPostings gives a same-id-space API job the sitemap tenant's plain /job/<slug>/<id>/ URL even when the sitemap lags", async (t) => {
  // indegene shape: the <id>-<locale> page redirect-loops; only the plain req-id URL serves the job.
  const indegene: AdapterCompany = { ...company, slug: "indegene", careersUrl: "https://careers.indegene.com", tenantUrl: null, apiMeta: { locale: "en_GB" } };
  stubCsb(t, `<urlset>
    <url><loc>https://careers.indegene.com/job/Kolind-ka-Bas-Web-Developer-KA/60273044/</loc></url>
    <url><loc>https://careers.indegene.com/job/Bangalore-Senior-Drupal-Developer/60515644/</loc></url>
  </urlset>`, [{
    totalJobs: 2,
    jobSearchResult: [
      { response: { id: "60273044", unifiedStandardTitle: "Web Developer", urlTitle: "Kolind-ka-Bas-Web-Developer-KA", jobLocationShort: ["Kolind ka Bas, KA, IN"], unifiedStandardStart: "9/1/26" } },
      { response: { id: "60600044", unifiedStandardTitle: "UI Designer", urlTitle: "Kolind-ka-Bas-UI-Designer-KA", jobLocationShort: ["Kolind ka Bas, KA, IN"], unifiedStandardStart: "10/12/26" } },
    ],
  }]);
  const postings = await sfcsbAdapter.listPostings(indegene);
  const byId = new Map(postings.map((p) => [p.externalId, p]));
  assert.equal(byId.get("60273044")?.jobUrl, "https://careers.indegene.com/job/Kolind-ka-Bas-Web-Developer-KA/60273044/");
  assert.equal(byId.get("60600044")?.jobUrl, "https://careers.indegene.com/job/Kolind-ka-Bas-UI-Designer-KA/60600044/");
  assert.equal(byId.get("60515644")?.jobTitle, "Bangalore Senior Drupal Developer");
  assert.equal(postings.length, 3);
});

test("parseSfcsbJd falls back to the richest joblayouttoken value when no itemprop=description span exists", () => {
  const html = `<div class="jobDisplay"><div class="job">
    <div class="joblayouttoken displayDTM"><span class="joblayouttoken-label">Title: </span><span lang="en-GB" class="rtltextaligneligible">Web Developer </span></div>
    <div class="joblayouttoken displayDTM"><span class="joblayouttoken-label">Date: </span><span lang="en-GB" class="rtltextaligneligible">24/09/2026 </span></div>
    <div class="joblayouttoken displayDTM"><span class="joblayouttoken-label">Description: </span><span lang="en-GB" class="rtltextaligneligible"><div><H2>Must Have</H2><p>Build accessible web apps.</p></div></span></div>
  </div></div>`;
  const jd = parseSfcsbJd(html);
  assert.match(jd, /Must Have/);
  assert.match(jd, /Build accessible web apps\./);
  assert.doesNotMatch(jd, /24\/09\/2026/);
});

test("listPostings: a sitemap fetch failure leaves the result identical to the API-only listing", async (t) => {
  stubFetch(t, (input, init) => {
    const url = String(input);
    if (url === "https://jobs.tuvsud.com/sitemap.xml") return Promise.resolve(htmlResponse("not found", 404));
    const body = typeof init?.body === "string" ? init.body : "";
    const m = /"pageNumber":(\d+)/.exec(body);
    const page = m ? Number(m[1]) : -1;
    return Promise.resolve(jsonResponse(page === 0 ? PAGE1 : PAGE2));
  });
  const postings = await sfcsbAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  assert.deepEqual(postings.map((p) => p.externalId).sort(), ["4262", "4644", "5161"]);
});
