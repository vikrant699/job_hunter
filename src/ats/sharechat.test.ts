// src/ats/sharechat.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenShareChatJobs, normalizeShareChat, ShareChatJobSchema } from "./sharechat.js";
import type { ShareChatJob } from "./sharechat.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "sharechat",
  slug: "sharechat",
  name: "ShareChat",
  careersUrl: "https://sharechat.com/careers",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed real shape from GET /api/careersList?limit=100 (2 categories, 3 jobs).
const listResponse = {
  data: {
    careersList: [
      {
        title: "Content & Operations",
        data: [
          {
            requisitionId: 2405,
            requisitionTitle: "Intern - Content Moderation(Tamil and Hindi)",
            orgUnitName: "Content & Operations",
            officeLocationNames: ["Bangalore"],
            jobDescription: null,
            createdDate: 1783330691698,
          },
          {
            requisitionId: 2390,
            requisitionTitle: "Video Editor- AI",
            orgUnitName: "Content & Operations",
            officeLocationNames: ["India"],
            jobDescription: "<p>Edit videos with <strong>AI tools</strong>.</p>",
            createdDate: 1779883145712,
          },
        ],
      },
      {
        title: "Design",
        data: [
          {
            requisitionId: 2317,
            requisitionTitle: "Senior Product Designer - IC",
            orgUnitName: "Design",
            officeLocationNames: ["Remote"],
            jobDescription: null,
            createdDate: 1771239038290,
          },
        ],
      },
    ],
    offsetToken: null,
    count: 3,
    hasNext: false,
  },
};

const job: ShareChatJob = {
  requisitionId: 2405,
  requisitionTitle: "Intern - Content Moderation(Tamil and Hindi)",
  orgUnitName: "Content & Operations",
  officeLocationNames: ["Bangalore"],
  jobDescription: null,
  createdDate: 1783330691698,
};

test("ShareChatJobSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(ShareChatJobSchema.safeParse(job).success);
  assert.ok(
    ShareChatJobSchema.safeParse({ requisitionId: 1, requisitionTitle: "x" }).success,
  );
  assert.equal(ShareChatJobSchema.safeParse({ requisitionTitle: "no id" }).success, false);
});

test("flattenShareChatJobs flattens every category's data[] into one array", () => {
  const jobs = flattenShareChatJobs(listResponse);
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((j) => j.requisitionId),
    [2405, 2390, 2317],
  );
});

test("normalizeShareChat maps fields: id, title, joined location, careers-page URL, ISO date", () => {
  const p = normalizeShareChat(company, job);
  assert.equal(p.provider, "sharechat");
  assert.equal(p.externalId, "2405");
  assert.equal(p.jobTitle, "Intern - Content Moderation(Tamil and Hindi)");
  assert.equal(p.jobUrl, "https://sharechat.com/careers");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date(1783330691698).toISOString());
});

test("normalizeShareChat strips HTML from jobDescription when present", () => {
  const jobs = flattenShareChatJobs(listResponse);
  const withJd = jobs.find((j) => j.requisitionId === 2390);
  assert.ok(withJd);
  const p = normalizeShareChat(company, withJd!);
  assert.match(p.jdText, /Edit videos with AI tools/);
  assert.doesNotMatch(p.jdText, /<p>|<strong>/);
});

test("normalizeShareChat: multi-location joins with comma; remote location sets isRemote", () => {
  const p = normalizeShareChat(company, { ...job, officeLocationNames: ["Bangalore", "Remote"] });
  assert.equal(p.location, "Bangalore, Remote");
  assert.equal(p.isRemote, true);
});

test("normalizeShareChat: missing officeLocationNames maps location to null", () => {
  const p = normalizeShareChat(company, { ...job, officeLocationNames: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});
