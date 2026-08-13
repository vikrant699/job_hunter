import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ujjivanAdapter, normalizeUjjivan } from "../ujjivan.js";
import type { AdapterCompany } from "../../types.js";
import { stubFetch, jsonResponse, mkAdapterCompany } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "ujjivan",
  slug: "ujjivan-small-finance-bank",
  name: "Ujjivan Small Finance Bank",
  careersUrl: "https://www.ujjivansfb.bank.in/careers",
});

test("normalizeUjjivan builds an India-tagged location from location_city", () => {
  const p = normalizeUjjivan(company, {
    job_id: 42,
    job_title: "Cashier",
    location_city: ["Bulandshahr", "Ajmer", "Bulandshahr"],
  });
  assert.equal(p.externalId, "42");
  assert.equal(p.location, "Bulandshahr, Ajmer, India");
  assert.equal(p.jdText, "");
});

test("fetchJd POSTs job_id to job-details and reads the (misspelled) job_decription field", async (t) => {
  let capturedUrl = "";
  let capturedBody = "";
  stubFetch(t, async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return jsonResponse({ data: { data: { job_decription: "<p>Lead the branch.</p>" } } });
  });
  const posting = normalizeUjjivan(company, { job_id: "5fb367a8568a4", job_title: "Branch Manager" });
  const jd = await ujjivanAdapter.fetchJd?.(company, posting);
  assert.equal(jd, "Lead the branch.");
  assert.ok(capturedUrl.endsWith("/api/jobs/job-details"));
  const body = z.object({ job_id: z.string() }).parse(JSON.parse(capturedBody));
  assert.equal(body.job_id, "5fb367a8568a4");
});

test("fetchJd falls back to correctly-spelled fields if the vendor fixes the typo", async (t) => {
  stubFetch(t, async () => jsonResponse({ data: { data: { job_description: "<p>Fixed spelling.</p>" } } }));
  const posting = normalizeUjjivan(company, { job_id: 7, job_title: "Analyst" });
  const jd = await ujjivanAdapter.fetchJd?.(company, posting);
  assert.equal(jd, "Fixed spelling.");
});
