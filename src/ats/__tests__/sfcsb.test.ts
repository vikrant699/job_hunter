// src/ats/__tests__/sfcsb.test.ts
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
import type { AdapterCompany } from "../../types.js";

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
        // HCL-style location shape (custprimecity + custCountryRegion)
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

test("sfcsbSearchBody is 1-based with empty keywords", () => {
  assert.deepEqual(sfcsbSearchBody(1), { keywords: "", locale: "en_US", pageNumber: 1 });
  assert.deepEqual(sfcsbSearchBody(3), { keywords: "", locale: "en_US", pageNumber: 3 });
});

test("sfcsbJobUrl builds the canonical <host>/job/<slug>/<id>-en_US/ link", () => {
  assert.equal(sfcsbJobUrl(company, "5161", "QA-Engineer"), "https://jobs.tuvsud.com/job/QA-Engineer/5161-en_US/");
  // no slug -> cosmetic placeholder
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
  assert.equal(j0.jdText, ""); // filled by fetchJd
  // HCL-shape location
  assert.equal(at(jobs, 1).location, "Noida, India");
  assert.equal(at(jobs, 1).isRemote, true); // "Remote" in title
});

test("parseSfcsbJd picks the richest itemprop=description span", () => {
  const jd = parseSfcsbJd(JD_HTML);
  assert.match(jd, /Responsibilities/);
  assert.match(jd, /Test the widgets\./);
});

test("listPostings paginates by pageNumber to totalJobs", async (t) => {
  const seen: number[] = [];
  stubFetch(t, (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const m = /"pageNumber":(\d+)/.exec(body);
    const page = m ? Number(m[1]) : 0;
    seen.push(page);
    return Promise.resolve(jsonResponse(page === 1 ? PAGE1 : PAGE2));
  });
  const postings = await sfcsbAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  assert.deepEqual(seen.slice(0, 2), [1, 2]);
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
  assert.deepEqual(sfcsbSearchBody(2, "en_GB"), { keywords: "", locale: "en_GB", pageNumber: 2 });
  assert.deepEqual(sfcsbSearchBody(1), { keywords: "", locale: "en_US", pageNumber: 1 });
});
