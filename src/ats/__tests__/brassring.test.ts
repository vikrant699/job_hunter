import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brassringAdapter,
  brassringConfig,
  brassringSearchBody,
  parseBrassringPage,
} from "../brassring.js";
import { at, asJson, fetchSequence, jsonResponse, stubFetch } from "./testHelpers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "brassring",
  slug: "adm",
  name: "ADM India",
  careersUrl: "https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=25416&siteid=5429",
  tenantUrl: null,
  apiMeta: { partnerId: "25416", siteId: "5429" },
};

function job(reqid: string, title: string, city: string, country: string, jd: string) {
  return {
    Link: `https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25416&siteid=5429&PageType=JobDetails&jobid=${reqid}`,
    IsActive: true,
    Questions: [
      { QuestionName: "reqid", Value: reqid },
      { QuestionName: "jobtitle", Value: title },
      { QuestionName: "lastupdated", Value: "13-Aug-2026" },
      { QuestionName: "department", Value: "Engineering" },
      { QuestionName: "formtext3", Value: jd },
      { QuestionName: "formtext8", Value: city },
      { QuestionName: "formtext10", Value: country },
    ],
  };
}

const PAGE1 = {
  JobsCount: 3,
  Jobs: {
    Job: [
      job("3383210", "Associate Director &amp; Lead", "Bengaluru", "India", "<strong>Your Responsibilities</strong><br>Lead the team."),
      job("3351798", "Engineer - Electrical", "Latur", "India", "<p>Wire things.</p>"),
    ],
  },
};
const PAGE2 = {
  JobsCount: 3,
  Jobs: { Job: [job("3379141", "Remote Data Analyst", "Hyderabad", "India", "<p>Analyze.</p>")] },
};

test("brassringConfig reads partnerId/siteId and defaults the column fields", () => {
  const cfg = brassringConfig(company);
  assert.equal(cfg.partnerId, "25416");
  assert.equal(cfg.siteId, "5429");
  assert.equal(cfg.cityField, "formtext8");
  assert.equal(cfg.countryField, "formtext10");
  assert.equal(cfg.jdField, "formtext3");
  assert.throws(() => brassringConfig({ ...company, apiMeta: { siteId: "5429" } }), /partnerId/i);
  assert.throws(() => brassringConfig({ ...company, apiMeta: { partnerId: "25416" } }), /siteId/i);
});

test("brassringSearchBody is 1-based and carries partner/site ids", () => {
  assert.deepEqual(brassringSearchBody(brassringConfig(company), 1), {
    partnerId: "25416",
    siteId: "5429",
    pageNumber: "1",
  });
});

test("parseBrassringPage flattens Questions, inlines JD, builds fields", () => {
  const { jobs, total } = parseBrassringPage(asJson(PAGE1), company);
  assert.equal(total, 3);
  assert.equal(jobs.length, 2);
  const j0 = at(jobs, 0);
  assert.equal(j0.provider, "brassring");
  assert.equal(j0.externalId, "3383210");
  assert.equal(j0.jobTitle, "Associate Director & Lead"); // entity-decoded
  assert.equal(j0.location, "Bengaluru, India");
  assert.equal(j0.jobUrl, "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25416&siteid=5429&PageType=JobDetails&jobid=3383210");
  assert.match(j0.jdText, /Your Responsibilities/);
  assert.match(j0.jdText, /Lead the team\./);
  assert.equal(j0.postedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(j0.isRemote, false);
});

test("listPostings paginates by pageNumber to the JobsCount total", async (t) => {
  const pages: string[] = [];
  stubFetch(t, (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const isPage1 = body.includes('"pageNumber":"1"');
    pages.push(isPage1 ? "1" : "2+");
    return Promise.resolve(jsonResponse(isPage1 ? PAGE1 : PAGE2));
  });
  const postings = await brassringAdapter.listPostings(company);
  assert.equal(postings.length, 3);
  assert.equal(pages[0], "1");
  assert.equal(pages[1], "2+");
  assert.equal(at(postings, 2).isRemote, true); // "Remote" in title
});

test("an empty board (JobsCount 0, no Job array) yields nothing", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ JobsCount: 0, Jobs: {} })));
  const postings = await brassringAdapter.listPostings(company);
  assert.equal(postings.length, 0);
});
