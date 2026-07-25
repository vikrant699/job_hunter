// src/ats/ceipal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ceipalAdapter,
  ceipalDescriptionUrl,
  ceipalDetailToken,
  ceipalListUrl,
  ceipalLocation,
  ceipalTeaser,
  ceipalTokens,
  normalizeCeipal,
  parseCeipalDate,
  type CeipalJob,
} from "./ceipal.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "ceipal", slug: "simplilearn", name: "Simplilearn",
  careersUrl: "https://www.simplilearn.com/job-openings", tenantUrl: null,
  apiMeta: { api_key: "NDlYd05RTlF2REZhaHVnTEdjT294dz09", cp_id: "Z3RkUkt2OXZJVld2MjFpOVRSTXoxZz09" },
};

const job: CeipalJob = {
  job_id: 94,
  position_title: "Inside Sales Specialist",
  public_job_title: "Inside Sales Specialist",
  city: "",
  state: "Karnataka",
  country: "India",
  multpile_job_location: "(Bengaluru, KA, 560001)",
  remote_opportunities: 0,
  requistion_description: "Job Title: Inside Sales Specialist &ndash; B2C<br>Location: HSR, Bangalore",
  public_job_desc: "Job Title: Inside Sales Specialist - B2C\nLocation: HSR, Bangalore",
  created: "30/March/2026",
  campus_portal_job_details_url: "https://candidateportal.ceipal.com/job-details/3M4gX1f5YUpHBCgzByGhm62DqQGI85YDKbSl6PmPv10",
};

// --- token / URL helpers ---------------------------------------------------

test("ceipalTokens reads api_key + cp_id from apiMeta", () => {
  assert.deepEqual(ceipalTokens(company), {
    apiKey: "NDlYd05RTlF2REZhaHVnTEdjT294dz09",
    cpId: "Z3RkUkt2OXZJVld2MjFpOVRSTXoxZz09",
  });
});

test("ceipalTokens throws without apiMeta.api_key/cp_id", () => {
  assert.throws(() => ceipalTokens({ ...company, apiMeta: null }), /requires apiMeta\.api_key and apiMeta\.cp_id/);
  assert.throws(() => ceipalTokens({ ...company, apiMeta: { api_key: "x" } }), /requires apiMeta\.api_key and apiMeta\.cp_id/);
});

test("ceipalListUrl builds the per-tenant CareerPortal list URL for a page", () => {
  assert.equal(
    ceipalListUrl("NDlYd05RTlF2REZhaHVnTEdjT294dz09", 2),
    "https://careerapi.ceipal.com/NDlYd05RTlF2REZhaHVnTEdjT294dz09/CareerPortalJobPostings/?page=2",
  );
});

// --- date parsing ------------------------------------------------------------

test("parseCeipalDate parses vendor's DD/Month/YYYY format to ISO", () => {
  assert.equal(parseCeipalDate("30/March/2026"), new Date("30 March 2026").toISOString());
  assert.equal(parseCeipalDate("10/July/2026"), new Date("10 July 2026").toISOString());
});

test("parseCeipalDate returns null for missing or unparseable input", () => {
  assert.equal(parseCeipalDate(null), null);
  assert.equal(parseCeipalDate(undefined), null);
  assert.equal(parseCeipalDate("Today"), null);
  assert.equal(parseCeipalDate(""), null);
});

// --- location ----------------------------------------------------------------

test("ceipalLocation prefers multpile_job_location, stripped of its parens", () => {
  assert.equal(ceipalLocation(job), "Bengaluru, KA, 560001");
});

test("ceipalLocation falls back to city/state/country when multpile_job_location is absent", () => {
  const j: CeipalJob = { ...job, multpile_job_location: null, city: "Thane" };
  assert.equal(ceipalLocation(j), "Thane, Karnataka, India");
});

test("ceipalLocation returns null when nothing usable is present", () => {
  const j: CeipalJob = { ...job, multpile_job_location: null, city: "", state: null, country: null };
  assert.equal(ceipalLocation(j), null);
});

// --- teaser (list JD, ~184-char truncation) ------------------------------------

test("ceipalTeaser prefers requistion_description and strips its HTML", () => {
  const t = ceipalTeaser(job);
  assert.match(t, /Inside Sales Specialist/);
  assert.match(t, /Location: HSR, Bangalore/);
  assert.doesNotMatch(t, /<br>|&ndash;/);
});

test("ceipalTeaser falls back to public_job_desc when requistion_description is null", () => {
  const t = ceipalTeaser({ ...job, requistion_description: null });
  assert.match(t, /Location: HSR, Bangalore/);
});

test("ceipalTeaser falls back to public_job_desc when requistion_description is an EMPTY string (not just null)", () => {
  // The API returns requistion_description:"" for some jobs whose public_job_desc
  // has content — a plain `??` would keep the empty string (defect).
  const t = ceipalTeaser({ ...job, requistion_description: "" });
  assert.match(t, /Location: HSR, Bangalore/);
});

// --- detail-endpoint helpers ---------------------------------------------------

test("ceipalDetailToken extracts the token from a /job-details/ URL", () => {
  assert.equal(
    ceipalDetailToken("https://candidateportal.ceipal.com/job-details/3M4gX1f5YUpHBCgzByGhm62DqQGI85YDKbSl6PmPv10"),
    "3M4gX1f5YUpHBCgzByGhm62DqQGI85YDKbSl6PmPv10",
  );
});

test("ceipalDetailToken returns null for the constructed careers-fallback URL (no detail token)", () => {
  assert.equal(ceipalDetailToken("https://www.simplilearn.com/job-openings?job=94"), null);
});

test("ceipalDescriptionUrl builds the candidate-portal full-JD endpoint", () => {
  assert.equal(
    ceipalDescriptionUrl("TOKEN123"),
    "https://candidateportal.ceipal.com/api/jobs/description/TOKEN123",
  );
});

// --- normalize -----------------------------------------------------------------

test("normalizeCeipal maps title, location, job URL, remote flag, and posted date; leaves jdText empty for fetchJd", () => {
  const p = normalizeCeipal(company, job);
  assert.equal(p.provider, "ceipal");
  assert.equal(p.externalId, "94");
  assert.equal(p.jobTitle, "Inside Sales Specialist");
  assert.equal(p.location, "Bengaluru, KA, 560001");
  assert.equal(p.jobUrl, "https://candidateportal.ceipal.com/job-details/3M4gX1f5YUpHBCgzByGhm62DqQGI85YDKbSl6PmPv10");
  assert.equal(p.isRemote, false);
  // The list JD is a truncated teaser — jdText is left empty so the pipeline
  // calls fetchJd for the full description.
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("30 March 2026").toISOString());
});

test("normalizeCeipal treats remote_opportunities=1 as remote regardless of location text", () => {
  const p = normalizeCeipal(company, { ...job, remote_opportunities: 1 });
  assert.equal(p.isRemote, true);
});

test("normalizeCeipal falls back to a constructed job URL when no detail URL is present", () => {
  const p = normalizeCeipal(company, { ...job, campus_portal_job_details_url: null });
  assert.equal(p.jobUrl, "https://www.simplilearn.com/job-openings?job=94");
});

// --- listPostings (paginated fetch) --------------------------------------------

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function pageResponse(_page: number, results: unknown[], count: number): Response {
  return new Response(JSON.stringify({ count, num_pages: Math.ceil(count / 20), results }), { status: 200 });
}

test("listPostings paginates full-size (20/page) pages via num_pages/count until the short last page ends it, sending the required Referer + fields", async () => {
  // Mirrors the live Simplilearn tenant shape: 54 jobs over 3 pages (20, 20, 14).
  const calls: { url: string; referer: string | null; fields: Record<string, string> }[] = [];
  const makePage = (start: number, n: number): CeipalJob[] =>
    Array.from({ length: n }, (_, i) => ({ ...job, job_id: start + i }));
  stubFetch(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("expected a FormData body");
    const fields: Record<string, string> = {};
    for (const [k, v] of body.entries()) fields[k] = String(v);
    calls.push({ url, referer: headers.get("Referer"), fields });
    const page = Number(fields.page);
    if (page === 1) return pageResponse(1, makePage(1, 20), 54);
    if (page === 2) return pageResponse(2, makePage(21, 20), 54);
    return pageResponse(3, makePage(41, 14), 54);
  });
  try {
    const postings = await ceipalAdapter.listPostings({ ...company, apiMeta: { api_key: "KEY123", cp_id: "CP456" } });
    assert.equal(postings.length, 54);
    assert.equal(postings[0]?.externalId, "1");
    assert.equal(postings[53]?.externalId, "54");
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://careerapi.ceipal.com/KEY123/CareerPortalJobPostings/?page=1");
    assert.equal(calls[0]?.referer, "https://jobsapi.ceipal.com/");
    assert.deepEqual(calls[0]?.fields, {
      page: "1", api_key: "KEY123", method: "CareerPortalJobPostings", cp_id: "CP456", from_career_portal: "1",
    });
    assert.equal(calls[2]?.fields.page, "3");
  } finally {
    restoreFetch();
  }
});

test("listPostings returns an empty array for a tenant with zero postings", async () => {
  stubFetch(async () => pageResponse(1, [], 0));
  try {
    const postings = await ceipalAdapter.listPostings(company);
    assert.deepEqual(postings, []);
  } finally {
    restoreFetch();
  }
});

test("listPostings throws on a malformed response (schema mismatch)", async () => {
  stubFetch(async () => new Response(JSON.stringify({ status: 400, success: 0, message: "Bot access is not allowed" }), { status: 200 }));
  try {
    await assert.rejects(ceipalAdapter.listPostings(company), /ceipal list response failed schema/);
  } finally {
    restoreFetch();
  }
});

test("listPostings surfaces the ATS HTTP error when the API 400s (missing Referer / bot-blocked)", async () => {
  stubFetch(async () => new Response(JSON.stringify({ status: 400, success: 0, message: "not allowed" }), { status: 400 }));
  try {
    await assert.rejects(ceipalAdapter.listPostings(company), /ceipal HTTP 400/);
  } finally {
    restoreFetch();
  }
});

// --- fetchJd (full JD from the candidate-portal detail endpoint) ----------------

const FULL_JD =
  "Job Title: Inside Sales Specialist &ndash; B2C<br />Location: HSR, Bangalore<br /><br />" +
  "About the role: drive B2C revenue, own the full sales cycle, exceed quota. " +
  "Responsibilities include qualifying leads, running demos, and closing deals. " +
  "Requirements: 1-5 years of inside sales experience, excellent communication, CRM fluency.";

function detailResponse(jobDescription: string | null): Response {
  return new Response(
    JSON.stringify({ status: 1, message: "ok", data: { jobInfo: { descriptionData: { jobDescription } } } }),
    { status: 200 },
  );
}

test("fetchJd retrieves the FULL description from the detail endpoint (not the truncated list teaser)", async () => {
  const posting = normalizeCeipal(company, job);
  const calls: { url: string; method: string }[] = [];
  stubFetch(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return detailResponse(FULL_JD);
  });
  try {
    const jd = await ceipalAdapter.fetchJd!(company, posting);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://candidateportal.ceipal.com/api/jobs/description/3M4gX1f5YUpHBCgzByGhm62DqQGI85YDKbSl6PmPv10",
    );
    assert.equal(calls[0]?.method, "GET");
    assert.match(jd, /own the full sales cycle/);
    assert.match(jd, /CRM fluency/);
    assert.doesNotMatch(jd, /<br|&ndash;/);
    // Full JD, well beyond the ~184-char list teaser.
    assert.ok(jd.length > 184, `expected full JD, got ${jd.length} chars`);
  } finally {
    restoreFetch();
  }
});

test("fetchJd falls back to the teaser (from public_job_desc, empty requistion_description) when the detail fetch fails", async () => {
  // Covers both the empty-string fallback (defect) and the detail-failure path.
  const posting = normalizeCeipal(company, { ...job, requistion_description: "" });
  stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    const jd = await ceipalAdapter.fetchJd!(company, posting);
    assert.match(jd, /Location: HSR, Bangalore/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd falls back to the teaser when the detail response carries an empty jobDescription", async () => {
  const posting = normalizeCeipal(company, job);
  stubFetch(async () => detailResponse(""));
  try {
    const jd = await ceipalAdapter.fetchJd!(company, posting);
    assert.match(jd, /Inside Sales Specialist/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd returns the teaser without any HTTP call when the posting has no detail token", async () => {
  const posting = normalizeCeipal(company, { ...job, campus_portal_job_details_url: null });
  let called = false;
  stubFetch(async () => {
    called = true;
    return detailResponse(FULL_JD);
  });
  try {
    const jd = await ceipalAdapter.fetchJd!(company, posting);
    assert.equal(called, false);
    assert.match(jd, /Inside Sales Specialist/);
  } finally {
    restoreFetch();
  }
});
