// src/ats/__tests__/talentfunnel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  talentfunnelAdapter,
  talentfunnelTenant,
  parseTalentfunnelList,
} from "../talentfunnel.js";
import { at, asJson, fetchSequence, jsonResponse, stubFetch } from "./testHelpers.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "talentfunnel",
  slug: "drmartens",
  name: "Dr. Martens India",
  careersUrl: "https://jobs.drmartens.com",
  tenantUrl: null,
  apiMeta: { tenant: "a3e88308-2615-4415-bb56-cc5267bc1ced" },
};

const RESPONSE = {
  totalResults: 3,
  results: [
    {
      vacancyId: "P9FstkJHPqLJ7So1Q1NNJ",
      jobTitle: "Senior QA Automation Engineer",
      applicationUrl: "https://forms.talent-funnel.com/form?id=1c4d70d9-409a-40d9-affe-b65356f23b8e",
      validFrom: "2026-06-12",
      hoursType: "FULL_TIME",
      location: { city: "Bengaluru", country: "IN", formattedAddress: "Bengaluru, Karnataka, India" },
    },
    {
      vacancyId: "52waN5zrQdEhBuRSONfMrv",
      jobTitle: "Lead ServiceNow Engineer (Remote)",
      applicationUrl: "https://forms.talent-funnel.com/form?id=c9204ff0-1111-2222-3333-444455556666",
      validFrom: "2026-06-11",
      hoursType: "FULL_TIME",
      location: { city: "Camden", country: "GB", formattedAddress: "Camden, London, UK" },
    },
  ],
};

const DETAIL = {
  positionProfile: {
    title: "Senior QA Automation Engineer",
    description: "<p>Own the <b>automation</b> suite.</p><ul><li>Playwright</li></ul>",
  },
};

test("talentfunnelTenant reads the tenant UUID from apiMeta", () => {
  assert.equal(talentfunnelTenant(company), "a3e88308-2615-4415-bb56-cc5267bc1ced");
  assert.throws(() => talentfunnelTenant({ ...company, apiMeta: null }), /tenant/i);
  assert.throws(() => talentfunnelTenant({ ...company, apiMeta: {} }), /tenant/i);
});

test("parseTalentfunnelList maps fields (JD deferred to fetchJd)", () => {
  const jobs = parseTalentfunnelList(asJson(RESPONSE), company);
  assert.equal(jobs.length, 2);
  const j0 = at(jobs, 0);
  assert.equal(j0.provider, "talentfunnel");
  assert.equal(j0.externalId, "P9FstkJHPqLJ7So1Q1NNJ");
  assert.equal(j0.jobTitle, "Senior QA Automation Engineer");
  assert.equal(j0.jobUrl, "https://forms.talent-funnel.com/form?id=1c4d70d9-409a-40d9-affe-b65356f23b8e");
  assert.equal(j0.location, "Bengaluru, Karnataka, India");
  assert.equal(j0.postedAt, "2026-06-12T00:00:00.000Z");
  assert.equal(j0.isRemote, false);
  assert.equal(j0.jdText, ""); // filled by fetchJd
  // "Remote" in the title flips isRemote.
  assert.equal(at(jobs, 1).isRemote, true);
});

test("fetchJd pulls positionProfile.description with the Tenant header", async (t) => {
  let seenUrl = "";
  let seenTenant: string | null = null;
  stubFetch(t, (input, init) => {
    seenUrl = typeof input === "string" ? input : input.toString();
    seenTenant = new Headers(init?.headers).get("Tenant");
    return Promise.resolve(jsonResponse(DETAIL));
  });
  const posting = at(parseTalentfunnelList(asJson(RESPONSE), company), 0);
  const jd = await talentfunnelAdapter.fetchJd?.(company, posting);
  assert.equal(seenUrl, "https://ats-api.talent-funnel.com/js/vacancy/P9FstkJHPqLJ7So1Q1NNJ");
  assert.equal(seenTenant, "a3e88308-2615-4415-bb56-cc5267bc1ced");
  assert.match(jd ?? "", /Own the automation suite\./);
  assert.match(jd ?? "", /Playwright/);
});

test("listPostings posts to the shared API with the Tenant header", async (t) => {
  let seenUrl = "";
  let seenMethod = "";
  let seenTenant: string | null = null;
  let seenBody = "";
  stubFetch(t, (input, init) => {
    seenUrl = typeof input === "string" ? input : input.toString();
    seenMethod = init?.method ?? "";
    seenTenant = new Headers(init?.headers).get("Tenant");
    seenBody = typeof init?.body === "string" ? init.body : "";
    return Promise.resolve(jsonResponse(RESPONSE));
  });
  const postings = await talentfunnelAdapter.listPostings(company);
  assert.equal(seenUrl, "https://ats-api.talent-funnel.com/js/search/vacancy");
  assert.equal(seenMethod, "POST");
  assert.equal(seenTenant, "a3e88308-2615-4415-bb56-cc5267bc1ced");
  assert.deepEqual(JSON.parse(seenBody), { limit: 5000 });
  assert.equal(postings.length, 2);
});

test("listPostings tolerates an empty board (valid tenant, no matches)", async (t) => {
  stubFetch(t, fetchSequence(() => jsonResponse({ results: [], totalResults: 0 })));
  const postings = await talentfunnelAdapter.listPostings(company);
  assert.equal(postings.length, 0);
});

test("a vacancy missing an applicationUrl falls back to the board URL", () => {
  const resp = { results: [{ vacancyId: "x1", jobTitle: "Analyst", location: { city: "Bengaluru", country: "IN" } }] };
  const jobs = parseTalentfunnelList(asJson(resp), company);
  assert.equal(at(jobs, 0).jobUrl, "https://jobs.drmartens.com");
  assert.equal(at(jobs, 0).location, "Bengaluru, IN");
});
