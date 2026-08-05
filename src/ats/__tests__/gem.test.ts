// src/ats/gem.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gemListRequestBody,
  gemJdRequestBody,
  gemJobUrl,
  parseGemJobBoardList,
  parseGemJobDetail,
  normalizeGem,
} from "../gem.js";
import type { GemJobStub } from "../gem.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "gem", slug: "promptql", name: "PromptQL",
  careersUrl: "https://jobs.gem.com/promptql", tenantUrl: null, apiMeta: null,
};

// Shape mirrors the real jobs.gem.com/api/public/graphql JobBoardList response
// for the promptql board (captured 2026-07-11).
const listResponse = {
  data: {
    oatsExternalJobPostings: {
      jobPostings: [
        {
          id: "T2F0c0pvYlBvc3Q6NDgyMjcz",
          extId: "am9icG9zdDqu29YsOTFpcE1k9t_ulIDY",
          title: "AI Staff Software Engineer",
          firstPublishedTsSec: 1750725369,
          locations: [
            { id: "30621", extId: "bG9jOqhJSPIDAsqYOoZ7ZbZSOcU", name: "San Francisco", city: "San Francisco", isoCountry: "USA", isRemote: false },
            { id: "30623", extId: "bG9jOmai-MdoVLzVzs4BT_lvPqw", name: "Remote - United States", city: "Remote - United States", isoCountry: "USA", isRemote: true },
          ],
          job: {
            id: "T2F0c0pvYjozMDAwNDU=",
            department: { id: "28254", extId: "ZGVwdDofMyc2-YiNAG73W6qzusOx", name: "Engineering" },
            locationType: "HYBRID",
            employmentType: "FULL_TIME",
          },
        },
        {
          id: "T2F0c0pvYlBvc3Q6MjcwMDYxMg==",
          extId: "am9icG9zdDqFcCqALL3yOrMp6tFzI6t8",
          title: "Forward Deployed Analyst, Bangalore",
          firstPublishedTsSec: 1753473137,
          locations: [
            { id: "30622", extId: "bG9jOilk4M_xyFJNk1KsufNhiQQ", name: "Bengaluru - Office", city: "Bengaluru", isoCountry: "IND", isRemote: false },
            { id: "31361", extId: "bG9jOkwiuasEezaDpQLsaoxFcJ8", name: "Remote - India", city: "Bengaluru", isoCountry: "IND", isRemote: true },
          ],
          job: {
            id: "T2F0c0pvYjoxODkyNjgx",
            department: { id: "28256", extId: "ZGVwdDptf-pNErz9dbuuQ4KuhjDP", name: "Forward Deployed Engineering" },
            locationType: "REMOTE",
            employmentType: "FULL_TIME",
          },
        },
      ],
    },
  },
};

const job: GemJobStub = at(listResponse.data.oatsExternalJobPostings.jobPostings, 0);

test("gemListRequestBody builds the JobBoardList operation with the board slug", () => {
  const body = gemListRequestBody("promptql");
  assert.equal(body.operationName, "JobBoardList");
  assert.deepEqual(body.variables, { boardId: "promptql" });
  assert.match(body.query, /query JobBoardList/);
});

test("gemJdRequestBody builds the ExternalJobPostingQuery operation with slug + extId", () => {
  const body = gemJdRequestBody("promptql", "am9icG9zdDqu29YsOTFpcE1k9t_ulIDY");
  assert.equal(body.operationName, "ExternalJobPostingQuery");
  assert.deepEqual(body.variables, { boardId: "promptql", extId: "am9icG9zdDqu29YsOTFpcE1k9t_ulIDY" });
  assert.match(body.query, /query ExternalJobPostingQuery/);
});

test("gemJobUrl builds the public board URL from slug + extId", () => {
  assert.equal(
    gemJobUrl("promptql", "am9icG9zdDqu29YsOTFpcE1k9t_ulIDY"),
    "https://jobs.gem.com/promptql/am9icG9zdDqu29YsOTFpcE1k9t_ulIDY"
  );
});

test("parseGemJobBoardList unwraps the jobPostings array", () => {
  const jobs = parseGemJobBoardList(listResponse);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.title, "AI Staff Software Engineer");
  assert.equal(jobs[1]?.extId, "am9icG9zdDqFcCqALL3yOrMp6tFzI6t8");
});

test("parseGemJobBoardList throws on an unexpected shape", () => {
  assert.throws(() => parseGemJobBoardList({ data: {} }));
});

test("parseGemJobDetail unwraps descriptionHtml", () => {
  const detail = { data: { oatsExternalJobPosting: { descriptionHtml: "<p>Build things.</p>" } } };
  assert.equal(parseGemJobDetail(detail), "<p>Build things.</p>");
});

test("parseGemJobDetail returns null when the posting is missing (pulled/unlisted)", () => {
  assert.equal(parseGemJobDetail({ data: { oatsExternalJobPosting: null } }), null);
});

test("parseGemJobDetail returns null on an unexpected shape", () => {
  assert.equal(parseGemJobDetail({ nope: true }), null);
});

test("normalizeGem maps fields: joined locations, hybrid job not flagged remote, ISO date", () => {
  const p = normalizeGem(company, job);
  assert.equal(p.provider, "gem");
  assert.equal(p.externalId, "am9icG9zdDqu29YsOTFpcE1k9t_ulIDY");
  assert.equal(p.jobTitle, "AI Staff Software Engineer");
  assert.equal(p.jobUrl, "https://jobs.gem.com/promptql/am9icG9zdDqu29YsOTFpcE1k9t_ulIDY");
  assert.equal(p.location, "San Francisco; Remote - United States");
  // One of the two locations IS remote, so the posting is remote-eligible even
  // though the job-level locationType is "HYBRID".
  assert.equal(p.isRemote, true);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date(1750725369 * 1000).toISOString());
});

test("normalizeGem: fully onsite job with no remote location is not flagged remote", () => {
  const onsite: GemJobStub = {
    ...job,
    locations: [{ id: "1", extId: "loc1", name: "Bengaluru - Office", city: "Bengaluru", isoCountry: "IND", isRemote: false }],
    job: { id: "j1", department: null, locationType: "ONSITE", employmentType: "FULL_TIME" },
  };
  const p = normalizeGem(company, onsite);
  assert.equal(p.location, "Bengaluru - Office");
  assert.equal(p.isRemote, false);
});

test("normalizeGem: missing locations/job/timestamp map to null", () => {
  const bare: GemJobStub = { id: "x", extId: "ext-x", title: "Something" };
  const p = normalizeGem(company, bare);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
  assert.equal(p.postedAt, null);
});
