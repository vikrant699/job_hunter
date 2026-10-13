import { test } from "node:test";
import assert from "node:assert/strict";
import { ceipalAdapter, ceipalDetailUrl, ceipalJobUrl, ceipalListUrl, ceipalLocation, ceipalTeaser, ceipalTokens, normalizeCeipal } from "../ceipal.js";
import type { CeipalJob } from "../ceipal.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "ceipal", slug: "acme", name: "Acme",
  careersUrl: "https://www.acme.example/job-openings", tenantUrl: null,
  apiMeta: { api_key: "KEY123", cp_id: "CP456" },
};
const tokens = { apiKey: "KEY123", cpId: "CP456" };

const job: CeipalJob = {
  id: "z5G7h3l6a1kMvyS65NP3c9wr_FbOlBO7UKiUA+IJqAM=",
  public_job_title: "Inside Sales Specialist",
  public_job_desc: "Job Title: Inside Sales Specialist &ndash; B2C\r\n\r\nLocation: HSR, Bangalore....",
  city: "",
  state: "Karnataka",
  country: "India",
  multpile_job_location: "(Bengaluru, KA, 560001)",
  remote_opportunities: 0,
};

test("ceipalTokens reads api_key + cp_id from apiMeta", () => {
  assert.deepEqual(ceipalTokens(company), tokens);
});

test("ceipalTokens throws without apiMeta.api_key/cp_id", () => {
  assert.throws(() => ceipalTokens({ ...company, apiMeta: null }), /requires apiMeta\.api_key and apiMeta\.cp_id/);
  assert.throws(() => ceipalTokens({ ...company, apiMeta: { api_key: "x" } }), /requires apiMeta\.api_key and apiMeta\.cp_id/);
});

test("ceipalListUrl builds the per-tenant CareerPortal list URL for a page", () => {
  assert.equal(ceipalListUrl("KEY123", 2), "https://careerapi.ceipal.com/KEY123/CareerPortalJobPostings/?page=2");
});

test("ceipalDetailUrl builds the per-job CareerPortal detail URL with the id encoded", () => {
  assert.equal(
    ceipalDetailUrl(tokens, "ab+c/d="),
    "https://careerapi.ceipal.com/KEY123/CareerPortalJobPostings/ab%2Bc%2Fd%3D/?from_career_portal=1&cp_id=CP456",
  );
});

test("ceipalJobUrl deep-links the public widget, which opens the job from its job_id param", () => {
  assert.equal(
    ceipalJobUrl(tokens, "ab+c="),
    "https://jobsapi.ceipal.com/APISource/v1/index.html?api_key=KEY123&cp_id=CP456&job_id=ab%2Bc%3D",
  );
});

test("ceipalLocation prefers multpile_job_location, stripped of its parens", () => {
  assert.equal(ceipalLocation(job), "Bengaluru, KA, 560001");
});

test("ceipalLocation falls back to city/state/country when multpile_job_location is empty", () => {
  assert.equal(ceipalLocation({ ...job, multpile_job_location: "", city: "Thane" }), "Thane, Karnataka, India");
  assert.equal(ceipalLocation({ ...job, multpile_job_location: "", state: "" }), "India");
});

test("ceipalLocation returns null when nothing usable is present", () => {
  assert.equal(ceipalLocation({ ...job, multpile_job_location: null, city: "", state: null, country: null }), null);
});

test("ceipalTeaser strips the list teaser's HTML entities", () => {
  const t = ceipalTeaser(job);
  assert.match(t, /Location: HSR, Bangalore/);
  assert.doesNotMatch(t, /&ndash;/);
});

test("normalizeCeipal maps id, title, location, widget job URL and remote flag; leaves jdText empty for fetchJd", () => {
  const p = normalizeCeipal(company, tokens, job);
  assert.equal(p.provider, "ceipal");
  assert.equal(p.externalId, job.id);
  assert.equal(p.jobTitle, "Inside Sales Specialist");
  assert.equal(p.location, "Bengaluru, KA, 560001");
  assert.equal(p.jobUrl, ceipalJobUrl(tokens, job.id));
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeCeipal treats remote_opportunities=1 as remote regardless of location text", () => {
  assert.equal(normalizeCeipal(company, tokens, { ...job, remote_opportunities: 1 }).isRemote, true);
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function pageResponse(results: CeipalJob[], count: number): Response {
  return new Response(JSON.stringify({ count, num_pages: Math.ceil(count / 20), results }), { status: 200 });
}

test("listPostings paginates 20/page until the short last page, sending the required Referer + fields", async () => {
  const calls: { url: string; referer: string | null; fields: Record<string, string> }[] = [];
  const makePage = (start: number, n: number): CeipalJob[] =>
    Array.from({ length: n }, (_, i) => ({ ...job, id: `id-${start + i}` }));
  stubFetch(async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("expected a FormData body");
    const fields: Record<string, string> = {};
    for (const [k, v] of body.entries()) fields[k] = String(v);
    calls.push({ url: String(input), referer: headers.get("Referer"), fields });
    const page = Number(fields.page);
    if (page === 1) return pageResponse(makePage(1, 20), 54);
    if (page === 2) return pageResponse(makePage(21, 20), 54);
    return pageResponse(makePage(41, 14), 54);
  });
  try {
    const postings = await ceipalAdapter.listPostings(company);
    assert.equal(postings.length, 54);
    assert.equal(postings[0]?.externalId, "id-1");
    assert.equal(postings[53]?.externalId, "id-54");
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://careerapi.ceipal.com/KEY123/CareerPortalJobPostings/?page=1");
    assert.equal(calls[0].referer, "https://jobsapi.ceipal.com/");
    assert.deepEqual(calls[0].fields, {
      page: "1", api_key: "KEY123", method: "CareerPortalJobPostings", cp_id: "CP456", from_career_portal: "1",
    });
    assert.equal(calls[2]?.fields.page, "3");
  } finally {
    restoreFetch();
  }
});

test("listPostings returns an empty array for a tenant with zero postings", async () => {
  stubFetch(async () => pageResponse([], 0));
  try {
    assert.deepEqual(await ceipalAdapter.listPostings(company), []);
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

const FULL_JD =
  "<p>About the role: drive B2C revenue, own the full sales cycle, exceed quota.</p>\r\n<ul><li>Qualify leads, run demos, close deals.</li>" +
  "<li>Requirements: 1-5 years of inside sales experience, excellent communication, CRM fluency.</li></ul>";

function detailResponse(publicJobDesc: string | null): Response {
  return new Response(JSON.stringify({ job_code: "JPC - 154", public_job_desc: publicJobDesc, public_job_title: "x" }), { status: 200 });
}

const { fetchJd } = ceipalAdapter;
assert(fetchJd);

test("fetchJd retrieves the full description from the per-job detail endpoint with the Referer", async () => {
  const posting = normalizeCeipal(company, tokens, job);
  const calls: { url: string; referer: string | null }[] = [];
  stubFetch(async (input, init) => {
    calls.push({ url: String(input), referer: new Headers(init?.headers).get("Referer") });
    return detailResponse(FULL_JD);
  });
  try {
    const jd = await fetchJd(company, posting);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, ceipalDetailUrl(tokens, job.id));
    assert.equal(calls[0].referer, "https://jobsapi.ceipal.com/");
    assert.match(jd, /own the full sales cycle/);
    assert.match(jd, /CRM fluency/);
    assert.doesNotMatch(jd, /<p>|<li>/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd falls back to the list teaser when the detail fetch fails", async () => {
  const posting = normalizeCeipal(company, tokens, job);
  stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    assert.match(await fetchJd(company, posting), /Location: HSR, Bangalore/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd falls back to the list teaser when the detail description is empty", async () => {
  const posting = normalizeCeipal(company, tokens, job);
  stubFetch(async () => detailResponse(""));
  try {
    assert.match(await fetchJd(company, posting), /Location: HSR, Bangalore/);
  } finally {
    restoreFetch();
  }
});
