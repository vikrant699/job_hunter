// src/ats/darwinbox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanDarwinboxJd,
  darwinboxJobUrl,
  legacyCompanyId,
  normalizeDarwinbox, darwinboxTenantBase, mergeDarwinboxPages,
  darwinboxV2Token, normalizeDarwinboxV2, mergeDarwinboxV2Pages,
  darwinboxLocation, darwinboxPagesNeeded,
} from "../darwinbox.js";
import type { DarwinboxJob, DarwinboxV2Job } from "../darwinbox.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";
import type { JsonValue } from "../../util/json.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "darwinbox", slug: "emeritus", name: "Emeritus",
  careersUrl: "https://emeritus.darwinbox.in/ms/candidate/careers",
  tenantUrl: "https://emeritus.darwinbox.in/ms/candidate/careers", apiMeta: null,
};

// candidatev2 fixture, modeled on the live LG Soft India tenant.
const v2Company: AdapterCompany = {
  provider: "darwinbox", slug: "lg-soft-india", name: "LG Soft India",
  careersUrl: "https://lgsihrms.darwinbox.in/ms/candidatev2/a6914476a29263/careers/home",
  tenantUrl: "https://lgsihrms.darwinbox.in/ms/candidatev2/a6914476a29263/careers/home", apiMeta: null,
};

const v2Job: DarwinboxV2Job = {
  id: "a6a4cc0c2b4e8d", title: "Control EMC Lab In-charge Eco Solution Products",
  designation_display_name: "Deputy Manager",
  officelocation_show_arr: "Noida, Uttar Pradesh, India (LOC_02)",
  is_remote: 0, created_on: "2026-07-07T09:02:58.000Z",
  jd: "&lt;p&gt;EMC Lab – In Charge&lt;/p&gt;",
};

const job: DarwinboxJob = {
  id: "a66faa21bc4531", title: "Team Leader - Sales", designation_display_name: "Team Leader",
  officelocation_show_arr: "Mumbai, Maharashtra, India", job_posting_on: 1780511400,
  created_on: "2024-09-30T13:05:31.000Z",
};

test("darwinboxTenantBase derives the origin", () => {
  assert.equal(darwinboxTenantBase(company), "https://emeritus.darwinbox.in");
});

test("normalizeDarwinbox maps fields, prefers title, converts epoch", () => {
  const p = normalizeDarwinbox(company, job);
  assert.equal(p.provider, "darwinbox");
  assert.equal(p.externalId, "a66faa21bc4531");
  assert.equal(p.jobTitle, "Team Leader - Sales");
  assert.equal(p.location, "Mumbai, Maharashtra, India");
  assert.equal(p.postedAt, new Date(1780511400 * 1000).toISOString());
  assert.equal(p.jobUrl, "https://emeritus.darwinbox.in/ms/candidatev2/main/careers/jobDetails/a66faa21bc4531");
});

test("normalizeDarwinbox falls back to designation when title empty", () => {
  const p = normalizeDarwinbox(company, { ...job, title: "" });
  assert.equal(p.jobTitle, "Team Leader");
});

// Darwinbox writes the literal placeholder "Multiple locations" on multi-city listings; nulling it defers to the recall-safe title/JD/URL filter instead of dropping as out-of-region.
test("darwinboxLocation nulls the 'Multiple locations' placeholder", () => {
  assert.equal(darwinboxLocation("Multiple locations"), null);
  assert.equal(darwinboxLocation("Multiple Locations"), null);
  assert.equal(darwinboxLocation("multiple location"), null);
  assert.equal(darwinboxLocation("  Multiple locations  "), null);
});

test("darwinboxLocation keeps a real location and nulls empty/missing ones", () => {
  assert.equal(darwinboxLocation("Mumbai, Maharashtra, India"), "Mumbai, Maharashtra, India");
  // A location that merely CONTAINS the phrase still carries real geo signal.
  assert.equal(darwinboxLocation("Multiple locations - Mumbai, Pune"), "Multiple locations - Mumbai, Pune");
  assert.equal(darwinboxLocation(""), null);
  assert.equal(darwinboxLocation("   "), null);
  assert.equal(darwinboxLocation(null), null);
  assert.equal(darwinboxLocation(undefined), null);
});

test("normalizeDarwinbox emits null location for the placeholder", () => {
  const p = normalizeDarwinbox(company, { ...job, officelocation_show_arr: "Multiple locations" });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("normalizeDarwinboxV2 emits null location for the placeholder", () => {
  const p = normalizeDarwinboxV2(v2Company, { ...v2Job, officelocation_show_arr: "Multiple locations" });
  assert.equal(p.location, null);
});

// The legacy list API serves 10 jobs/page; the cap is a runaway backstop only, never a truncation - matches turbohire's "fetch every page" rule.
test("darwinboxPagesNeeded covers the whole board without truncating", () => {
  assert.equal(darwinboxPagesNeeded(684, 10), 69);
  assert.equal(darwinboxPagesNeeded(20, 10), 2);
  // >100 pages must NOT be clamped to 100 (the old silent 1000-job ceiling).
  assert.equal(darwinboxPagesNeeded(4000, 10), 400);
});

test("darwinboxPagesNeeded guards against a zero/absent page size", () => {
  assert.equal(darwinboxPagesNeeded(50, 0), 50);
  assert.equal(darwinboxPagesNeeded(0, 10), 0);
});

function page(jobs: DarwinboxJob[]): JsonValue {
  return asJson({ status: "ok", message: { jobscount: null, jobs } });
}

test("mergeDarwinboxPages accumulates valid pages in order", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([job]), page([{ ...job, id: "2" }])], 2);
  assert.deepEqual(out.map((p) => p.externalId), ["a66faa21bc4531", "2"]);
});

test("mergeDarwinboxPages stops once total is reached", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([job]), page([{ ...job, id: "2" }])], 1);
  assert.deepEqual(out.map((p) => p.externalId), ["a66faa21bc4531"]);
});

test("mergeDarwinboxPages stops on an empty page", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxPages(company, out, [page([]), page([{ ...job, id: "2" }])], 5);
  assert.deepEqual(out, []);
});

test("mergeDarwinboxPages throws (not warn+truncate) on a mid-pagination schema mismatch", () => {
  const out: NormalizedPosting[] = [{ ...normalizeDarwinbox(company, job) }];
  assert.throws(
    () => mergeDarwinboxPages(company, out, [{ status: "ok", message: { jobs: "not-an-array" } }], 5),
    /darwinbox page \(fetched \d+\/\d+ so far\) response failed schema for emeritus/,
  );
  // Must not silently keep only the partial list - the throw happens before any further mutation from this malformed page.
  assert.equal(out.length, 1);
});

test("darwinboxV2Token extracts the per-tenant token from a candidatev2 URL", () => {
  assert.equal(darwinboxV2Token(v2Company), "a6914476a29263");
  // "main" is a valid token too (e.g. the Duroflex registry row).
  const mainTokenCompany: AdapterCompany = {
    ...v2Company,
    careersUrl: "https://duroflex.darwinbox.in/ms/candidatev2/main/careers/allJobs",
    tenantUrl: "https://duroflex.darwinbox.in/ms/candidatev2/main/careers/allJobs",
  };
  assert.equal(darwinboxV2Token(mainTokenCompany), "main");
});

test("darwinboxV2Token returns null for a legacy careers URL", () => {
  assert.equal(darwinboxV2Token(company), null);
});

test("normalizeDarwinboxV2 maps fields, prefers title, and inlines the decoded JD", () => {
  const p = normalizeDarwinboxV2(v2Company, v2Job);
  assert.equal(p.provider, "darwinbox");
  assert.equal(p.externalId, "a6a4cc0c2b4e8d");
  assert.equal(p.jobTitle, "Control EMC Lab In-charge Eco Solution Products");
  assert.equal(p.location, "Noida, Uttar Pradesh, India (LOC_02)");
  assert.equal(p.postedAt, "2026-07-07T09:02:58.000Z");
  assert.equal(p.jobUrl, "https://lgsihrms.darwinbox.in/ms/candidatev2/a6914476a29263/careers/jobDetails/a6a4cc0c2b4e8d");
  // JD arrives already inline — no fetchJd round trip needed for candidatev2.
  assert.equal(p.jdText, "EMC Lab – In Charge");
});

test("normalizeDarwinboxV2 falls back to designation when title empty", () => {
  const p = normalizeDarwinboxV2(v2Company, { ...v2Job, title: "" });
  assert.equal(p.jobTitle, "Deputy Manager");
});

test("normalizeDarwinboxV2 treats is_remote as authoritative over the location regex", () => {
  const p = normalizeDarwinboxV2(v2Company, { ...v2Job, is_remote: 1 });
  assert.equal(p.isRemote, true);
});

function v2Page(jobs: DarwinboxV2Job[]): JsonValue {
  return asJson({ status: "success", data: jobs, job_counts: null });
}

test("mergeDarwinboxV2Pages accumulates valid pages in order", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxV2Pages(v2Company, out, [v2Page([v2Job]), v2Page([{ ...v2Job, id: "2" }])], 2);
  assert.deepEqual(out.map((p) => p.externalId), ["a6a4cc0c2b4e8d", "2"]);
});

test("mergeDarwinboxV2Pages stops on an empty page", () => {
  const out: NormalizedPosting[] = [];
  mergeDarwinboxV2Pages(v2Company, out, [v2Page([]), v2Page([{ ...v2Job, id: "2" }])], 5);
  assert.deepEqual(out, []);
});

test("mergeDarwinboxV2Pages throws (not warn+truncate) on a mid-pagination schema mismatch", () => {
  const out: NormalizedPosting[] = [{ ...normalizeDarwinboxV2(v2Company, v2Job) }];
  assert.throws(
    () => mergeDarwinboxV2Pages(v2Company, out, [{ status: "success", data: "not-an-array" }], 5),
    /darwinbox v2 page \(fetched \d+\/\d+ so far\) response failed schema for lg-soft-india/,
  );
  assert.equal(out.length, 1);
});

test("cleanDarwinboxJd nulls the editor placeholder, keeps real JDs", () => {
  assert.equal(cleanDarwinboxJd("Please enter job description"), "");
  assert.equal(cleanDarwinboxJd(" please enter job description. "), "");
  assert.equal(cleanDarwinboxJd("Build our payments stack."), "Build our payments stack.");
});

test("legacyCompanyId extracts the tenant token from the careers path, defaulting to main", () => {
  const mk = (url: string): AdapterCompany => ({ ...company, tenantUrl: url });
  assert.equal(legacyCompanyId(mk("https://pwhr.darwinbox.in/ms/candidate/a62d7a6e288992/careers")), "a62d7a6e288992");
  assert.equal(legacyCompanyId(mk("https://acme.darwinbox.in/ms/candidate/careers")), "main");
  assert.equal(legacyCompanyId(mk("https://acme.darwinbox.in")), "main");
});

test("darwinboxJobUrl deep-links under candidatev2 with the tenant token for both generations", () => {
  const mk = (url: string): AdapterCompany => ({ ...company, tenantUrl: url });
  assert.equal(
    darwinboxJobUrl(mk("https://pwhr.darwinbox.in/ms/candidate/a62d7a6e288992/careers"), "a1"),
    "https://pwhr.darwinbox.in/ms/candidatev2/a62d7a6e288992/careers/jobDetails/a1",
  );
  assert.equal(darwinboxJobUrl(mk("https://acme.darwinbox.in"), "a1"), "https://acme.darwinbox.in/ms/candidatev2/main/careers/jobDetails/a1");
});
