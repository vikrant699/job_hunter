// src/ats/talent500.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  talent500Adapter,
  talent500ListUrl,
  talent500DetailUrl,
  talent500JobUrl,
  talent500CompanyUrl,
  talent500ShouldKeep,
  talent500FilterWasIgnored,
  normalizeTalent500Job,
  talent500SlugFromUrl,
  buildTalent500Jd,
  type Talent500Job,
  type Talent500Detail,
} from "../talent500.js";
import { jsonResponse, stubFetch } from "./test-helpers.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/error-cause.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "talent500",
  slug: "best-buy-india",
  name: "Best Buy India",
  careersUrl: "https://talent500.com/jobs?company=best-buy-india",
  tenantUrl: null,
  apiMeta: null,
};

// --- URL builders -----------------------------------------------------------

test("talent500ListUrl builds a company_slug-filtered, offset/size-paged URL", () => {
  assert.equal(
    talent500ListUrl("best-buy-india", 0, 50),
    "https://prod-warmachine.talent500.co/api/v3/jobs/search/?company_slug=best-buy-india&offset=0&size=50",
  );
  assert.equal(
    talent500ListUrl("best-buy-india", 50),
    "https://prod-warmachine.talent500.co/api/v3/jobs/search/?company_slug=best-buy-india&offset=50&size=50",
  );
});

test("talent500DetailUrl builds the job-slug detail endpoint", () => {
  assert.equal(
    talent500DetailUrl("software-engineer-i-qa-bengaluru-T500-26950"),
    "https://prod-warmachine.talent500.co/api/jobs/software-engineer-i-qa-bengaluru-T500-26950/",
  );
});

test("talent500JobUrl builds the public job page URL", () => {
  assert.equal(
    talent500JobUrl("software-engineer-i-qa-bengaluru-T500-26950"),
    "https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950",
  );
});

// --- talent500ShouldKeep -----------------------------------------------------

const baseJob: Talent500Job = {
  id: "a1b2c3d4-0000-0000-0000-000000000001",
  title_alias_1: "Software Engineer I - QA",
  title: "SDE1",
  slug: "software-engineer-i-qa-bengaluru-T500-26950",
  location: "Bengaluru",
  country: { name: "India", country_code: "IN" },
  is_remote: false,
  created_at: "2026-06-24T14:51:54.811468+05:30",
  status: "open",
  is_active: true,
  is_job_displayable: true,
};

test("talent500ShouldKeep keeps a displayable, active, open job", () => {
  assert.equal(talent500ShouldKeep(baseJob), true);
});

test("talent500ShouldKeep drops a closed job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, status: "closed" }), false);
});

test("talent500ShouldKeep drops an undisplayable job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, is_job_displayable: false }), false);
});

test("talent500ShouldKeep drops an inactive job", () => {
  assert.equal(talent500ShouldKeep({ ...baseJob, is_active: false }), false);
});

// --- normalizeTalent500Job ---------------------------------------------------

test("normalizeTalent500Job maps fields correctly", () => {
  const p = normalizeTalent500Job(company, baseJob);
  assert.equal(p.provider, "talent500");
  assert.equal(p.externalId, "a1b2c3d4-0000-0000-0000-000000000001");
  assert.equal(p.jobTitle, "Software Engineer I - QA");
  assert.equal(p.jobUrl, "https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950");
  assert.equal(p.location, "Bengaluru");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-06-24T14:51:54.811468+05:30").toISOString());
});

test("normalizeTalent500Job falls back to title when title_alias_1 is empty", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, title_alias_1: "" });
  assert.equal(p.jobTitle, "SDE1");
});

test("normalizeTalent500Job falls back to title when title_alias_1 is missing", () => {
  const job: Talent500Job = {
    id: baseJob.id,
    slug: baseJob.slug,
    title: "SDE1",
    location: baseJob.location,
    country: baseJob.country,
    is_remote: baseJob.is_remote,
    created_at: baseJob.created_at,
    status: baseJob.status,
    is_active: baseJob.is_active,
    is_job_displayable: baseJob.is_job_displayable,
  };
  const p = normalizeTalent500Job(company, job);
  assert.equal(p.jobTitle, "SDE1");
});

test("normalizeTalent500Job flags isRemote from is_remote true", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, is_remote: true, location: "Bengaluru" });
  assert.equal(p.isRemote, true);
});

test("normalizeTalent500Job flags isRemote from a REMOTE_RE-matching location", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, is_remote: null, location: "Remote - India" });
  assert.equal(p.isRemote, true);
});

test("normalizeTalent500Job maps an unparseable/absent created_at to null postedAt", () => {
  const p = normalizeTalent500Job(company, { ...baseJob, created_at: null });
  assert.equal(p.postedAt, null);
});

// --- talent500SlugFromUrl -----------------------------------------------------

test("talent500SlugFromUrl derives the job slug from the public jobUrl", () => {
  assert.equal(
    talent500SlugFromUrl("https://talent500.com/jobs/software-engineer-i-qa-bengaluru-T500-26950"),
    "software-engineer-i-qa-bengaluru-T500-26950",
  );
});

test("talent500SlugFromUrl throws on a URL with no path segment", () => {
  assert.throws(() => talent500SlugFromUrl("https://talent500.com/"), /could not derive job slug/);
});

// --- buildTalent500Jd ---------------------------------------------------------

test("buildTalent500Jd concatenates the JD-bearing fields in order and strips HTML", () => {
  const detail: Talent500Detail = {
    role_summary: "<p>Own the QA process for our platform.</p>",
    description: "<p>We are looking for a QA engineer.</p>",
    responsibilities: "<ul><li>Write test plans</li><li>Automate regressions</li></ul>",
    what_you_need_to_succeed: "<p>3+ years of QA experience.</p>",
    typical_workday: "<p>Should never appear in the JD.</p>",
    what_you_offer: "<p>Should never appear in the JD.</p>",
  };
  const jd = buildTalent500Jd(detail);
  assert.match(jd, /Own the QA process/);
  assert.match(jd, /looking for a QA engineer/);
  assert.match(jd, /Write test plans/);
  assert.match(jd, /3\+ years of QA experience/);
  assert.doesNotMatch(jd, /Should never appear/);
  assert.doesNotMatch(jd, /<p>|<ul>|<li>/);

  // order: role_summary before description before responsibilities before what_you_need_to_succeed
  const iRole = jd.indexOf("Own the QA process");
  const iDesc = jd.indexOf("looking for a QA engineer");
  const iResp = jd.indexOf("Write test plans");
  const iNeed = jd.indexOf("3+ years");
  assert.ok(iRole < iDesc);
  assert.ok(iDesc < iResp);
  assert.ok(iResp < iNeed);
});

test("buildTalent500Jd skips empty/missing fields", () => {
  const jd = buildTalent500Jd({
    role_summary: "",
    description: "<p>Only this field is present.</p>",
    responsibilities: null,
    what_you_need_to_succeed: undefined,
  });
  assert.match(jd, /Only this field is present/);
});

test("buildTalent500Jd throws when no JD-bearing field yields text", () => {
  assert.throws(
    () => buildTalent500Jd({ role_summary: "", description: null, responsibilities: undefined }),
    /no JD-bearing fields/,
  );
});

// --- dead tenant vs empty board -----------------------------------------------
//
// Shapes below are trimmed from live probes of prod-warmachine.talent500.co on
// 2026-08-02. The distinction under test: a slug that does not exist is NOT
// answered with an empty board — the server drops the company_slug filter and
// serves the whole aggregator, so the row would silently import thousands of
// other employers' postings.

/** One list row, only the fields the adapter reads. */
function row(id: string, companySlug: string | null): Talent500Job {
  return {
    id,
    title: "Software Engineer",
    slug: `software-engineer-${id}`,
    ...(companySlug === null ? {} : { company: { slug: companySlug } }),
  };
}

// Verbatim shape of GET …/search/?company_slug=zzz-no-such-tenant-9x: HTTP 200,
// the filter dropped, total 6190 (the entire aggregator), rows belonging to
// whichever employers happen to sort first.
const UNFILTERED_FEED = {
  total: 6190,
  data: [row("00bc53fe", "aatechhubindia"), row("11cd64ef", "albertsonsindia"), row("22de75f0", "summit-consulting")],
};

// A LIVE tenant with nothing open. ciena, zinnia, aveva, alfa-laval, vip-india
// and csgi all returned exactly this on 2026-08-02 while resolving 200 at
// /api/companies/<slug>/. This is the case the guard must never swallow.
const EMPTY_BOARD = { total: 0, data: [] };

const nokia: AdapterCompany = {
  provider: "talent500",
  slug: "nokia",
  name: "Nokia India",
  careersUrl: "https://talent500.com/jobs/nokia/",
  tenantUrl: null,
  apiMeta: null,
};

test("talent500CompanyUrl builds the company-profile existence endpoint", () => {
  assert.equal(talent500CompanyUrl("nokia"), "https://prod-warmachine.talent500.co/api/companies/nokia/");
});

test("talent500FilterWasIgnored spots a response made of other employers' rows", () => {
  assert.equal(talent500FilterWasIgnored(UNFILTERED_FEED.data, "best-buy-india"), true);
});

test("talent500FilterWasIgnored accepts a page that contains this company's rows", () => {
  assert.equal(talent500FilterWasIgnored([row("a", "nokia"), row("b", "nokia")], "nokia"), false);
});

test("talent500FilterWasIgnored stays quiet on an empty page and on rows with no company object", () => {
  // Neither shape can answer "was the filter applied?", and guessing wrong here
  // fails a working board — so both must fail open.
  assert.equal(talent500FilterWasIgnored([], "nokia"), false);
  assert.equal(talent500FilterWasIgnored([row("a", null), row("b", null)], "nokia"), false);
});

test("listPostings rejects a dead slug served as the unfiltered aggregator feed", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse(UNFILTERED_FEED)));
  await assert.rejects(
    () => talent500Adapter.listPostings({ ...company, slug: "zzz-no-such-tenant-9x" }),
    /talent500: tenant does not exist/,
  );
});

test("the dead-tenant error is charged to the company, not written off as infrastructure", async (t) => {
  // A dead slug is a real per-company defect and MUST count toward the row's
  // consecutive_failures. If any of these flipped true the scheduler would
  // retry the board forever and never quarantine it.
  stubFetch(t, () => Promise.resolve(jsonResponse(UNFILTERED_FEED)));
  const err = await talent500Adapter
    .listPostings({ ...company, slug: "zzz-no-such-tenant-9x" })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("listPostings returns [] for a LIVE tenant whose board is empty and whose profile resolves", async (t) => {
  const seen: string[] = [];
  stubFetch(t, (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/api/companies/")) return Promise.resolve(jsonResponse({ id: "e26be649", slug: "nokia" }));
    return Promise.resolve(jsonResponse(EMPTY_BOARD));
  });
  assert.deepEqual(await talent500Adapter.listPostings(nokia), []);
  assert.equal(seen.length, 2, "empty page 1 should trigger exactly one existence probe");
  assert.equal(seen[1], talent500CompanyUrl("nokia"));
});

test("listPostings throws when an empty board's slug 404s at the company endpoint", async (t) => {
  stubFetch(t, (input) => {
    if (String(input).includes("/api/companies/")) return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(jsonResponse(EMPTY_BOARD));
  });
  await assert.rejects(() => talent500Adapter.listPostings(nokia), /talent500: tenant does not exist/);
});

test("an empty board survives the company endpoint answering 400 'Not Published'", async (t) => {
  // 15 of the 85 live rows (aramco, bp, zillow, kaspersky, …) answer 400 there
  // while listing jobs perfectly well — only a 404 may fail the company.
  stubFetch(t, (input) => {
    if (String(input).includes("/api/companies/")) {
      return Promise.resolve(new Response('"Not Published"', { status: 400 }));
    }
    return Promise.resolve(jsonResponse(EMPTY_BOARD));
  });
  assert.deepEqual(await talent500Adapter.listPostings(nokia), []);
});

test("an empty board survives the existence probe failing at the transport layer", async (t) => {
  stubFetch(t, (input) => {
    if (String(input).includes("/api/companies/")) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(jsonResponse(EMPTY_BOARD));
  });
  assert.deepEqual(await talent500Adapter.listPostings(nokia), []);
});

test("listPostings still parses a populated board unchanged", async (t) => {
  const page = {
    total: 2,
    data: [
      { ...row("37c30ddf", "nokia"), title_alias_1: "Senior Technical Specialist", location: "Bengaluru" },
      { ...row("48d41eea", "nokia"), title_alias_1: "Test Engineer", location: "Chennai" },
    ],
  };
  stubFetch(t, () => Promise.resolve(jsonResponse(page)));
  const postings = await talent500Adapter.listPostings(nokia);
  assert.equal(postings.length, 2);
  assert.equal(postings[0]?.jobTitle, "Senior Technical Specialist");
  assert.equal(postings[1]?.location, "Chennai");
});

test("a populated page is never re-audited on later pages", async (t) => {
  // Page 2+ must not run the filter check: only page 1 decides the tenant is
  // real, and a board that already produced postings can never be failed here.
  const full = { total: 60, data: Array.from({ length: 50 }, (_, i) => row(`nokia-${i}`, "nokia")) };
  // The vendor re-serving a stray foreign row deep in the crawl must not
  // quarantine a board that has already yielded 50 postings.
  const tail = { total: 60, data: [row("stray", "some-other-employer")] };
  let call = 0;
  stubFetch(t, () => Promise.resolve(jsonResponse(call++ === 0 ? full : tail)));
  const postings = await talent500Adapter.listPostings(nokia);
  assert.equal(postings.length, 51);
});
