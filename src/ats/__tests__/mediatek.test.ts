// src/ats/mediatek.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  mediatekApiUrl,
  mediatekPageJobs,
  normalizeMediatek,
  mediatekCityCodes,
  DEFAULT_MEDIATEK_CITY_CODES,
} from "../mediatek.js";
import type { MediatekJob } from "../mediatek.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "mediatek", slug: "mediatek", name: "MediaTek",
  careersUrl: "https://careers.mediatek.com/en/jobs",
  tenantUrl: null, apiMeta: null,
};

// Real shape captured live 2026-07-13 from
// GET https://careers.mediatek.com/api/trpc/job.getJobs?batch=1&input=...
const job: MediatekJob = {
  id: "MTB120260618001",
  title: "SRAM Design Engineer",
  description:
    "•\tDesign FCI (Fast Cache instances) for xPU (CPU/GPU) systems with the SRAM team.\n" +
    "•\tDefine design specs with CPU/GPU/APU teams.\n" +
    "•\tOptimize SRAM for power, timing, area, and yield.\n" +
    "•\tImplement Single Port & Two Port SRAM circuits.\n",
  publishedDate: "2026-06-17T16:00:00.000+00:00",
};

test("mediatekApiUrl builds the batched tRPC GET URL with the city code in the locations filter", () => {
  const url = mediatekApiUrl(company, "0000168800", 1);
  assert.match(url, /^https:\/\/careers\.mediatek\.com\/api\/trpc\/job\.getJobs\?batch=1&input=/);
  const input = new URL(url).searchParams.get("input");
  assert.ok(input);
  const InputSchema = z.object({
    "0": z.object({ json: z.object({ page: z.number(), filters: z.object({ locations: z.array(z.string()) }) }) }),
  });
  const parsed = InputSchema.parse(JSON.parse(input));
  assert.equal(parsed["0"].json.page, 1);
  assert.deepEqual(parsed["0"].json.filters.locations, ["0000168800"]);
});

test("mediatekApiUrl derives the origin from careersUrl when tenantUrl is absent", () => {
  const url = mediatekApiUrl({ ...company, tenantUrl: null }, "9021", 2);
  assert.match(url, /^https:\/\/careers\.mediatek\.com\//);
});

function page(jobs: MediatekJob[], pagination?: { current_page: number; total_pages: number; total_items: number }) {
  return [{ result: { data: { json: { status: "complete", jobs, pagination: pagination ?? null } } } }];
}

test("mediatekPageJobs unwraps the tRPC batch envelope and total_items", () => {
  const r = mediatekPageJobs(asJson(page([job], { current_page: 1, total_pages: 0, total_items: 21 })));
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0]?.title, "SRAM Design Engineer");
  assert.equal(r.totalItems, 21);
});

test("mediatekPageJobs tolerates a null pagination block", () => {
  const r = mediatekPageJobs(asJson(page([])));
  assert.deepEqual(r.jobs, []);
  assert.equal(r.totalItems, null);
});

test("normalizeMediatek maps fields, tags location from the QUERIED city (not the job object), strips HTML-free description", () => {
  const p = normalizeMediatek(company, job, "0000168800");
  assert.equal(p.provider, "mediatek");
  assert.equal(p.externalId, "MTB120260618001");
  assert.equal(p.jobTitle, "SRAM Design Engineer");
  assert.equal(p.jobUrl, "https://careers.mediatek.com/en/jobs/MTB120260618001");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /SRAM team/);
  assert.equal(p.postedAt, new Date("2026-06-17T16:00:00.000+00:00").toISOString());
});

test("normalizeMediatek falls back to the raw code as location for an unknown city code", () => {
  const p = normalizeMediatek(company, job, "0000099999");
  assert.equal(p.location, "0000099999");
});

test("normalizeMediatek maps a missing/unparseable publishedDate to null", () => {
  const p = normalizeMediatek(company, { ...job, publishedDate: null }, "0000168800");
  assert.equal(p.postedAt, null);
});

test("normalizeMediatek: empty description maps to empty jdText", () => {
  const p = normalizeMediatek(company, { ...job, description: null }, "0000168800");
  assert.equal(p.jdText, "");
});

test("mediatekCityCodes defaults to the verified India codes when apiMeta is absent", () => {
  assert.deepEqual(mediatekCityCodes(company), DEFAULT_MEDIATEK_CITY_CODES);
});

test("mediatekCityCodes reads a comma-separated apiMeta.cityCodes override", () => {
  const c: AdapterCompany = { ...company, apiMeta: { cityCodes: "1111,2222, 3333" } };
  assert.deepEqual(mediatekCityCodes(c), ["1111", "2222", "3333"]);
});

test("mediatekCityCodes falls back to defaults for an empty apiMeta.cityCodes string", () => {
  const c: AdapterCompany = { ...company, apiMeta: { cityCodes: "" } };
  assert.deepEqual(mediatekCityCodes(c), DEFAULT_MEDIATEK_CITY_CODES);
});
