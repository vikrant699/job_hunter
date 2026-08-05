// src/ats/feishu.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFeishu, feishuLocation, feishuAdapter } from "../feishu.js";
import type { FeishuJobPost, FeishuMeta } from "../feishu.js";
import type { AdapterCompany } from "../../types.js";

const realFetch = globalThis.fetch;
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
function stubFetchSeq(responses: Array<() => Response>): void {
  let i = 0;
  const fetchStub: typeof fetch = async () => {
    const make = responses[i];
    i += 1;
    if (!make) throw new Error(`unexpected extra fetch call (#${i})`);
    return make();
  };
  globalThis.fetch = fetchStub;
}
function restoreFetch(): void { globalThis.fetch = realFetch; }

const company: AdapterCompany = {
  provider: "feishu", slug: "bytedance", name: "ByteDance",
  careersUrl: "https://jobs.bytedance.com/en/position", tenantUrl: null,
  apiMeta: {
    apiBase: "https://jobs.bytedance.com/api/v1/public/supplier",
    jobUrlBase: "https://jobs.bytedance.com/en/position",
    websitePath: "en", locationCodes: "CT_44",
  },
};
const m: FeishuMeta = {
  apiBase: "https://jobs.bytedance.com/api/v1/public/supplier",
  jobUrlBase: "https://jobs.bytedance.com/en/position", websitePath: "en", locationCodes: ["CT_44"],
};
const job: FeishuJobPost = {
  id: "7464798457813190919",
  title: "Solutions Architect - BytePlus - Gurgaon",
  description: "<p>Own <b>cloud</b> solutions</p>",
  requirement: "<p>5y experience</p>",
  city_info: { en_name: "Gurgaon", parent: { en_name: "Haryana", parent: { en_name: "India", parent: null } } },
};

test("feishuLocation flattens the city -> state -> country chain", () => {
  assert.equal(feishuLocation(job.city_info), "Gurgaon, Haryana, India");
  assert.equal(feishuLocation({ en_name: "Remote", parent: null }), "Remote");
  assert.equal(feishuLocation(null), null);
  assert.equal(feishuLocation({ en_name: null, parent: { en_name: "India" } }), "India");
});

test("normalizeFeishu maps fields, builds /detail URL, inlines description+requirement JD", () => {
  const p = normalizeFeishu(company, m, job);
  assert.equal(p.externalId, "7464798457813190919");
  assert.equal(p.jobTitle, "Solutions Architect - BytePlus - Gurgaon");
  assert.equal(p.location, "Gurgaon, Haryana, India");
  assert.equal(p.jobUrl, "https://jobs.bytedance.com/en/position/7464798457813190919/detail");
  assert.match(p.jdText, /Own cloud solutions/);
  assert.match(p.jdText, /5y experience/);
  assert.doesNotMatch(p.jdText, /<p>|<b>/);
});

test("normalizeFeishu: remote location -> isRemote true", () => {
  const p = normalizeFeishu(company, m, { ...job, city_info: { en_name: "Remote", parent: null } });
  assert.equal(p.isRemote, true);
});

test("listPostings returns the India-scoped page (single short page)", async () => {
  const list = [job, { ...job, id: "2", title: "Data Analyst Intern" }];
  stubFetchSeq([() => jsonResponse({ code: 0, data: { job_post_list: list, count: 2 } })]);
  try {
    const posts = await feishuAdapter.listPostings(company);
    assert.deepEqual(posts.map((p) => p.externalId), ["7464798457813190919", "2"]);
  } finally {
    restoreFetch();
  }
});

test("listPostings paginates full pages until count is reached", async () => {
  const full = Array.from({ length: 50 }, (_, i) => ({ ...job, id: String(i + 1) }));
  const tail = Array.from({ length: 10 }, (_, i) => ({ ...job, id: String(51 + i) }));
  stubFetchSeq([
    () => jsonResponse({ code: 0, data: { job_post_list: full, count: 60 } }),
    () => jsonResponse({ code: 0, data: { job_post_list: tail, count: 60 } }),
  ]);
  try {
    const posts = await feishuAdapter.listPostings(company);
    assert.equal(posts.length, 60);
  } finally {
    restoreFetch();
  }
});

test("listPostings throws a clear error when apiMeta.apiBase is missing", async () => {
  const c: AdapterCompany = { ...company, apiMeta: { jobUrlBase: "x" } };
  await assert.rejects(feishuAdapter.listPostings(c), /apiMeta\.apiBase/);
});
