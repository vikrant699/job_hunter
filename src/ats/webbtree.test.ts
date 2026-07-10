import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeWebbtreeEntities,
  extractServerAppStateIsland,
  parseServerAppState,
  webbtreeJobsFromIsland,
  extractCeToken,
  normalizeWebbtree,
  postingsFromWebbtreeHtml,
  webbtreeListUrl,
  webbtreeJdRequestBody,
  webbtreeCustomUrlHeader,
  webbtreeAdapter,
  WebbtreeJobSchema,
} from "./webbtree.js";
import type { AdapterCompany } from "../types.js";

function makeCompany(slug: string, overrides: Partial<AdapterCompany> = {}): AdapterCompany {
  return {
    provider: "webbtree",
    slug,
    name: "ideaForge",
    careersUrl: webbtreeListUrl(slug),
    tenantUrl: null,
    apiMeta: null,
    ...overrides,
  };
}

// Webbtree's TransferState serializer: JSON.stringify the whole island, then
// escape every literal "&" to "&a;" FIRST (so the escape tokens it inserts
// aren't themselves re-escaped), then every literal '"' to "&q;".
function encodeIsland(obj: unknown): string {
  return JSON.stringify(obj).replace(/&/g, "&a;").replace(/"/g, "&q;");
}

const CE_TOKEN = "iOaplOOYx4AfrULYSGkaesweqeq";
const SLUG = "ideaforge";

function companyInfoEntry(slug: string, ceToken: string) {
  const url =
    `https://appapi.webbtree.com/candidate/company/getcompanyinfo?domain=${slug}/${ceToken}` +
    `&c_n=${slug}&c_e=${ceToken}`;
  return {
    [url]: {
      headers: { normalizedNames: {}, lazyUpdate: null },
      status: 200,
      url,
      ok: true,
      body: { status: "success", message: [{ name: slug, companynumber: "qwer23" }] },
    },
  };
}

function getjobsEntry(jobs: ReadonlyArray<Record<string, unknown>>) {
  const url = "https://appapi.webbtree.com/candidate/jobs/getjobs";
  return {
    [url]: {
      headers: { normalizedNames: {}, lazyUpdate: null },
      status: 200,
      url,
      ok: true,
      body: { status: "success", message: jobs },
    },
  };
}

const job1 = {
  jobnumber: "8d4c660a-5d85-48a4-b17f-96824914198f",
  jobname: "Service Engineer -UAV Systems_ Jammu",
  functions: "Customer Support & Success",
  locationname: "Navi Mumbai,India",
  employmenttype: "contract",
  remotelocation: 0,
  jobdescriptionurl: `https://app.webbtree.com/${SLUG}/${CE_TOKEN}/job-board/career/jobdetail/8d4c660a-5d85-48a4-b17f-96824914198f`,
};

const job2 = {
  jobnumber: "66ef1f95-b4af-4785-a9a2-7d13ff2b27ff",
  jobname: "HR Intern",
  functions: "Human Resource",
  locationname: null,
  employmenttype: "Internship",
  remotelocation: true,
  jobdescriptionurl: null,
};

/** Wrap an island object in a realistic page: junk before/after the script tag. */
function pageWith(island: unknown): string {
  return [
    "<!DOCTYPE html><html><head><title>Careers</title></head><body>",
    "<app-root></app-root>",
    `<script id="serverApp-state" type="application/json">${encodeIsland(island)}</script>`,
    "<script>document.title='ideaForge Careers';</script>",
    "</body></html>",
  ].join("");
}

function fullIsland(jobs: ReadonlyArray<Record<string, unknown>> = [job1, job2]) {
  return { ...companyInfoEntry(SLUG, CE_TOKEN), ...getjobsEntry(jobs) };
}

// ---------------------------------------------------------------------------
// decodeWebbtreeEntities
// ---------------------------------------------------------------------------

test("decodeWebbtreeEntities decodes &q; and &a; in one pass", () => {
  assert.equal(decodeWebbtreeEntities("&q;hello&q;"), '"hello"');
  assert.equal(decodeWebbtreeEntities("a &a; b"), "a & b");
  assert.equal(decodeWebbtreeEntities('{&q;a&q;:1}'), '{"a":1}');
});

test("decodeWebbtreeEntities round-trips text containing both & and \" via the encoder's escape order", () => {
  const original = 'Maintain & follow "Work Instruction" sheet';
  const encoded = original.replace(/&/g, "&a;").replace(/"/g, "&q;");
  assert.equal(decodeWebbtreeEntities(encoded), original);
});

test("decodeWebbtreeEntities does not re-scan a decoded &a; as the start of a new entity", () => {
  // "&a;q;" is an encoded "&" immediately followed by literal "q;" text — a
  // naive two-pass (first &a;->&, then re-scan for &q;) would wrongly fuse
  // them into a decoded quote. Single-pass regex must leave it as "&q;" text.
  assert.equal(decodeWebbtreeEntities("&a;q;"), "&q;");
});

// ---------------------------------------------------------------------------
// extractServerAppStateIsland
// ---------------------------------------------------------------------------

test("extractServerAppStateIsland finds the island script contents", () => {
  const raw = extractServerAppStateIsland(pageWith(fullIsland()));
  assert.ok(raw !== null);
  assert.match(raw!, /^\{/);
  assert.match(raw!, /&q;/); // still entity-escaped at this point
});

test("extractServerAppStateIsland returns null when the island is absent", () => {
  assert.equal(extractServerAppStateIsland("<html><body>no board here</body></html>"), null);
  assert.equal(extractServerAppStateIsland(""), null);
});

// ---------------------------------------------------------------------------
// parseServerAppState
// ---------------------------------------------------------------------------

test("parseServerAppState decodes, JSON-parses, and zod-validates the island", () => {
  const raw = extractServerAppStateIsland(pageWith(fullIsland()))!;
  const island = parseServerAppState(raw, SLUG);
  const keys = Object.keys(island);
  assert.equal(keys.length, 2);
  assert.ok(keys.some((k) => k.includes("getcompanyinfo")));
  assert.ok(keys.some((k) => k.includes("getjobs")));
});

test("parseServerAppState throws an actionable error on non-JSON garbage", () => {
  assert.throws(
    () => parseServerAppState("not json at all", SLUG),
    /webbtree serverApp-state island is not valid JSON for ideaforge/,
  );
});

test("parseServerAppState throws an actionable error when the shape is wrong", () => {
  // A top-level array (not a Record<string, {url, body}>) means the
  // TransferState serialization changed shape.
  assert.throws(
    () => parseServerAppState(encodeIsland([1, 2, 3]), SLUG),
    /webbtree serverApp-state island failed schema for ideaforge/,
  );
});

// ---------------------------------------------------------------------------
// webbtreeJobsFromIsland
// ---------------------------------------------------------------------------

test("webbtreeJobsFromIsland extracts the jobs array from the getjobs entry", () => {
  const island = parseServerAppState(encodeIsland(fullIsland()), SLUG);
  const jobs = webbtreeJobsFromIsland(island, SLUG);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.jobnumber, job1.jobnumber);
});

test("webbtreeJobsFromIsland throws when no getjobs entry is present", () => {
  const island = parseServerAppState(encodeIsland(companyInfoEntry(SLUG, CE_TOKEN)), SLUG);
  assert.throws(
    () => webbtreeJobsFromIsland(island, SLUG),
    /webbtree: no getjobs entry in serverApp-state island for ideaforge/,
  );
});

test("webbtreeJobsFromIsland throws when the getjobs body fails schema", () => {
  const badIsland = {
    "https://appapi.webbtree.com/candidate/jobs/getjobs": {
      url: "https://appapi.webbtree.com/candidate/jobs/getjobs",
      body: { status: "success", message: [{ jobname: "no jobnumber field" }] },
    },
  };
  const island = parseServerAppState(encodeIsland(badIsland), SLUG);
  assert.throws(
    () => webbtreeJobsFromIsland(island, SLUG),
    /webbtree getjobs response failed schema for ideaforge/,
  );
});

test("webbtreeJobsFromIsland returns [] for an empty (but present) board", () => {
  const island = parseServerAppState(encodeIsland(getjobsEntry([])), SLUG);
  assert.deepEqual(webbtreeJobsFromIsland(island, SLUG), []);
});

// ---------------------------------------------------------------------------
// extractCeToken
// ---------------------------------------------------------------------------

test("extractCeToken reads the token from the getcompanyinfo request URL", () => {
  const island = parseServerAppState(encodeIsland(fullIsland()), SLUG);
  const jobs = webbtreeJobsFromIsland(island, SLUG);
  assert.equal(extractCeToken(island, jobs), CE_TOKEN);
});

test("extractCeToken falls back to a job's jobdescriptionurl when no getcompanyinfo entry is present", () => {
  const island = parseServerAppState(encodeIsland(getjobsEntry([job1])), SLUG);
  const jobs = webbtreeJobsFromIsland(island, SLUG);
  assert.equal(extractCeToken(island, jobs), CE_TOKEN);
});

test("extractCeToken returns null when neither source carries the token", () => {
  const island = parseServerAppState(encodeIsland(getjobsEntry([job2])), SLUG);
  const jobs = webbtreeJobsFromIsland(island, SLUG);
  assert.equal(extractCeToken(island, jobs), null);
});

// ---------------------------------------------------------------------------
// WebbtreeJobSchema
// ---------------------------------------------------------------------------

test("WebbtreeJobSchema tolerates missing optionals but requires jobnumber+jobname", () => {
  assert.ok(WebbtreeJobSchema.safeParse({ jobnumber: "1", jobname: "T" }).success);
  assert.equal(WebbtreeJobSchema.safeParse({ jobnumber: "1" }).success, false);
  assert.equal(WebbtreeJobSchema.safeParse({ jobname: "T" }).success, false);
});

// ---------------------------------------------------------------------------
// normalizeWebbtree
// ---------------------------------------------------------------------------

test("normalizeWebbtree maps fields onto NormalizedPosting", () => {
  const company = makeCompany(SLUG);
  const p = normalizeWebbtree(company, job1);
  assert.equal(p.provider, "webbtree");
  assert.equal(p.externalId, job1.jobnumber);
  assert.equal(p.companySlug, SLUG);
  assert.equal(p.companyName, "ideaForge");
  assert.equal(p.jobTitle, "Service Engineer -UAV Systems_ Jammu");
  assert.equal(p.jobUrl, job1.jobdescriptionurl);
  assert.equal(p.location, "Navi Mumbai, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeWebbtree treats remotelocation:true as remote and falls back the jobUrl when jobdescriptionurl is absent", () => {
  const company = makeCompany(SLUG);
  const p = normalizeWebbtree(company, job2);
  assert.equal(p.isRemote, true);
  assert.equal(p.location, null);
  assert.equal(p.jobUrl, webbtreeListUrl(SLUG));
});

// ---------------------------------------------------------------------------
// postingsFromWebbtreeHtml
// ---------------------------------------------------------------------------

test("postingsFromWebbtreeHtml maps the full island into postings", () => {
  const company = makeCompany(SLUG);
  const postings = postingsFromWebbtreeHtml(company, pageWith(fullIsland()));
  assert.equal(postings.length, 2);
  assert.equal(postings[0]!.jobTitle, job1.jobname);
  assert.equal(postings[1]!.jobTitle, job2.jobname);
});

test("postingsFromWebbtreeHtml returns [] for an empty board", () => {
  const company = makeCompany("empty-tenant");
  const postings = postingsFromWebbtreeHtml(company, pageWith(getjobsEntry([])));
  assert.deepEqual(postings, []);
});

test("postingsFromWebbtreeHtml throws when the island is missing entirely", () => {
  const company = makeCompany(SLUG);
  assert.throws(
    () => postingsFromWebbtreeHtml(company, "<html><body>WAF interstitial</body></html>"),
    /webbtree: no serverApp-state island at/,
  );
});

// ---------------------------------------------------------------------------
// webbtreeJdRequestBody / webbtreeCustomUrlHeader
// ---------------------------------------------------------------------------

test("webbtreeJdRequestBody builds the shared request body with the hardcoded companynumber placeholder", () => {
  assert.deepEqual(webbtreeJdRequestBody(SLUG, job1.jobnumber, CE_TOKEN), {
    companynumber: "qwer23",
    jobnumber: job1.jobnumber,
    candidatenumber: null,
    c_n: SLUG,
    c_e: CE_TOKEN,
  });
});

test("webbtreeCustomUrlHeader builds /<slug>/<token>", () => {
  assert.equal(webbtreeCustomUrlHeader(SLUG, CE_TOKEN), `/${SLUG}/${CE_TOKEN}`);
});

// ---------------------------------------------------------------------------
// webbtreeAdapter (network-mocked)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("webbtreeAdapter.listPostings fetches the board and returns mapped postings", async () => {
  let requestedUrl: string | undefined;
  stubFetch(async (url) => {
    requestedUrl = String(url);
    return new Response(pageWith(fullIsland()), { status: 200 });
  });
  try {
    const company = makeCompany(SLUG);
    const postings = await webbtreeAdapter.listPostings(company);
    assert.equal(requestedUrl, "https://app.webbtree.com/company/ideaforge/jobs");
    assert.equal(postings.length, 2);
    assert.equal(postings[0]!.externalId, job1.jobnumber);
  } finally {
    restoreFetch();
  }
});

test("webbtreeAdapter.fetchJd reuses the token cached by listPostings — no second board fetch", async () => {
  const slug = "cache-hit-tenant";
  let boardFetches = 0;
  let jdCall: { url: string; body: unknown; headers: Record<string, string> } | undefined;
  stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/company/")) {
      boardFetches++;
      return new Response(pageWith(fullIsland()), { status: 200 });
    }
    const headers = new Headers(init?.headers);
    jdCall = {
      url: u,
      body: JSON.parse(String(init?.body)),
      headers: { customurl: headers.get("customurl") ?? "" },
    };
    return new Response(
      JSON.stringify({ status: "success", message: { details: { jobdescription: "<p>Do the job.</p>" } } }),
      { status: 200 },
    );
  });
  try {
    const company = makeCompany(slug);
    const postings = await webbtreeAdapter.listPostings(company);
    assert.equal(boardFetches, 1);
    const jd = await webbtreeAdapter.fetchJd!(company, postings[0]!);
    assert.equal(boardFetches, 1, "fetchJd should reuse the cached token, not re-fetch the board");
    assert.equal(jd, "Do the job.");
    assert.equal(jdCall?.url, "https://appapi.webbtree.com/candidate/jobs/getjobdetails");
    assert.deepEqual(jdCall?.body, webbtreeJdRequestBody(slug, postings[0]!.externalId, CE_TOKEN));
    assert.equal(jdCall?.headers.customurl, `/${slug}/${CE_TOKEN}`);
  } finally {
    restoreFetch();
  }
});

test("webbtreeAdapter.fetchJd uses company.apiMeta.c_e directly, skipping any board fetch", async () => {
  const slug = "apimeta-tenant";
  let boardFetches = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/company/")) {
      boardFetches++;
      return new Response(pageWith(fullIsland()), { status: 200 });
    }
    return new Response(
      JSON.stringify({ status: "success", message: { details: { jobdescription: "JD text" } } }),
      { status: 200 },
    );
  });
  try {
    const company = makeCompany(slug, { apiMeta: { c_e: "preset-token" } });
    const posting = normalizeWebbtree(company, job1);
    const jd = await webbtreeAdapter.fetchJd!(company, posting);
    assert.equal(boardFetches, 0);
    assert.equal(jd, "JD text");
  } finally {
    restoreFetch();
  }
});

test("webbtreeAdapter.fetchJd re-derives the token via a fresh board fetch when apiMeta and the cache are both empty", async () => {
  const slug = "cold-cache-tenant";
  let boardFetches = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/company/")) {
      boardFetches++;
      return new Response(pageWith(fullIsland()), { status: 200 });
    }
    return new Response(
      JSON.stringify({ status: "success", message: { details: { jobdescription: "JD text" } } }),
      { status: 200 },
    );
  });
  try {
    const company = makeCompany(slug);
    const posting = normalizeWebbtree(company, job1);
    const jd = await webbtreeAdapter.fetchJd!(company, posting);
    assert.equal(boardFetches, 1);
    assert.equal(jd, "JD text");
  } finally {
    restoreFetch();
  }
});

test("webbtreeAdapter.fetchJd returns '' and logs a warning on a malformed getjobdetails response", async () => {
  const slug = "malformed-jd-tenant";
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/company/")) return new Response(pageWith(fullIsland()), { status: 200 });
    // jobdescription as a number (not a string) fails WebbtreeJobDetailsResponseSchema.
    return new Response(
      JSON.stringify({ status: "success", message: { details: { jobdescription: 12345 } } }),
      { status: 200 },
    );
  });
  try {
    const company = makeCompany(slug);
    const postings = await webbtreeAdapter.listPostings(company);
    const jd = await webbtreeAdapter.fetchJd!(company, postings[0]!);
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
});
