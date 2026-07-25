// src/ats/happyeasygo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHappyEasyGo, flattenDepartment, happyeasygoAdapter } from "./happyeasygo.js";
import type { HappyEasyGoDepartment, HappyEasyGoPosition } from "./happyeasygo.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "happyeasygo", slug: "happyeasygo", name: "HappyEasyGo",
  careersUrl: "https://www.happyeasygo.com/Careers/", tenantUrl: null, apiMeta: null,
};

// Trimmed from a live fetch of getDepartmentJobList.do (2026-07-11).
const marketingDept: HappyEasyGoDepartment = {
  departmentId: "6",
  departmentName: "Marketing",
  joinUsMessages: [
    {
      id: 19,
      departmentId: "6",
      position: "Executive - Marketing Operations",
      workPlace: "Gurugram",
      jobDescription: "<p>Manage brand positioning across platforms.</p>",
      workRequirements: "<ul><li>2+ years experience</li></ul>",
      createTime: 1547475963000,
    },
    {
      id: 20,
      departmentId: "6",
      position: "Sr.Manager - Marketing",
      workPlace: "Gurugram",
      jobDescription: "<p>Own marketing strategy.</p>",
      workRequirements: null,
      createTime: 1553249092000,
    },
  ],
};

test("normalizeHappyEasyGo maps fields, joins JD + requirements, strips HTML", () => {
  const p = normalizeHappyEasyGo(company, marketingDept.joinUsMessages![0]!, marketingDept, 0);
  assert.equal(p.provider, "happyeasygo");
  assert.equal(p.externalId, "19");
  assert.equal(p.jobTitle, "Executive - Marketing Operations");
  assert.equal(p.location, "Gurugram");
  assert.equal(p.jobUrl, "https://www.happyeasygo.com/Careers/");
  assert.match(p.jdText, /Manage brand positioning/);
  assert.match(p.jdText, /2\+ years experience/);
  assert.doesNotMatch(p.jdText, /<p>|<li>/);
  assert.equal(p.postedAt, new Date(1547475963000).toISOString());
});

test("normalizeHappyEasyGo falls back to Gurugram, India when workPlace is null", () => {
  const p = normalizeHappyEasyGo(company, { ...marketingDept.joinUsMessages![0]!, workPlace: null }, marketingDept, 0);
  assert.equal(p.location, "Gurugram, India");
});

test("normalizeHappyEasyGo synthesizes externalId from departmentId+index when id is missing", () => {
  const noId: HappyEasyGoPosition = { ...marketingDept.joinUsMessages![0]!, id: null };
  const p = normalizeHappyEasyGo(company, noId, marketingDept, 2);
  assert.equal(p.externalId, "6-2");
});

test("normalizeHappyEasyGo omits a null workRequirements from the JD instead of joining an empty section", () => {
  const p = normalizeHappyEasyGo(company, marketingDept.joinUsMessages![1]!, marketingDept, 1);
  assert.match(p.jdText, /Own marketing strategy/);
});

test("flattenDepartment maps every position with its own index", () => {
  const out = flattenDepartment(company, marketingDept);
  assert.deepEqual(out.map((p) => p.externalId), ["19", "20"]);
});

test("flattenDepartment returns [] for a department with no joinUsMessages", () => {
  const out = flattenDepartment(company, { departmentId: "9", departmentName: "Empty Dept", joinUsMessages: null });
  assert.deepEqual(out, []);
});

const realFetch = globalThis.fetch;
function setFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function stubFetch(payload: unknown): void {
  setFetch(async () => new Response(JSON.stringify(payload), { status: 200 }));
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("happyeasygoAdapter.listPostings flattens every department across the whole payload", async () => {
  stubFetch({
    code: 0, succ: true,
    data: [marketingDept, { departmentId: "3", departmentName: "Customer Service", joinUsMessages: [{ id: 3, departmentId: "3", position: "Customer Care Executive", workPlace: "Gurugram", jobDescription: "<p>Answer calls.</p>", workRequirements: null, createTime: 1533549775000 }] }],
    token: "x", noteInfo: null,
  });
  try {
    const out = await happyeasygoAdapter.listPostings(company);
    assert.deepEqual(out.map((p) => p.externalId).sort(), ["19", "20", "3"]);
  } finally {
    restoreFetch();
  }
});

test("happyeasygoAdapter.listPostings throws when succ is false", async () => {
  stubFetch({ code: 1, succ: false, data: [] });
  try {
    await assert.rejects(() => happyeasygoAdapter.listPostings(company), /empty\/unsuccessful/);
  } finally {
    restoreFetch();
  }
});

test("happyeasygoAdapter.listPostings throws when data is empty", async () => {
  stubFetch({ code: 0, succ: true, data: [] });
  try {
    await assert.rejects(() => happyeasygoAdapter.listPostings(company), /empty\/unsuccessful/);
  } finally {
    restoreFetch();
  }
});

test("happyeasygoAdapter.listPostings throws on schema mismatch", async () => {
  stubFetch({ code: 0, succ: true, data: "not-an-array" });
  try {
    await assert.rejects(() => happyeasygoAdapter.listPostings(company), /happyeasygo list response failed schema/);
  } finally {
    restoreFetch();
  }
});
