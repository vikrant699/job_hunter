// src/ats/digitalrecruiters.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDigitalRecruiters, digitalRecruitersAdapter } from "../digitalrecruiters.js";
import type { DrListItem, DigitalRecruitersMeta } from "../digitalrecruiters.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const realFetch = globalThis.fetch;
function jsonResponse<T>(body: T): Response {
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
  provider: "digitalrecruiters", slug: "decathlon", name: "Decathlon India",
  careersUrl: "https://joinus.decathlon.in/en/annonces", tenantUrl: null,
  apiMeta: { domainName: "joinus.decathlon.in", locale: "en_GB", localePath: "en", jobPathSlug: "annonces" },
};
const m: DigitalRecruitersMeta = { domainName: "joinus.decathlon.in", locale: "en_GB", localePath: "en", jobPathSlug: "annonces" };
const item: DrListItem = { job_ad_id: 4457689, title: "Java Developer (SDE II)", location: "Bengaluru", contract: "Permanent contract", url: "4457689-java-developer-sde-ii-bengaluru" };
const { fetchJd } = digitalRecruitersAdapter;
assert(fetchJd);

test("normalizeDigitalRecruiters maps fields + builds the /en/annonces/<slug> job URL, leaves JD empty", () => {
  const p = normalizeDigitalRecruiters(company, m, item);
  assert.equal(p.externalId, "4457689");
  assert.equal(p.jobTitle, "Java Developer (SDE II)");
  assert.equal(p.location, "Bengaluru");
  assert.equal(p.isRemote, false);
  assert.equal(p.jobUrl, "https://joinus.decathlon.in/en/annonces/4457689-java-developer-sde-ii-bengaluru");
  assert.equal(p.jdText, "");
});

test("normalizeDigitalRecruiters falls back to the id as slug when url is missing", () => {
  const p = normalizeDigitalRecruiters(company, m, { ...item, url: null });
  assert.equal(p.jobUrl, "https://joinus.decathlon.in/en/annonces/4457689");
});

test("normalizeDigitalRecruiters: remote location -> isRemote true", () => {
  const p = normalizeDigitalRecruiters(company, m, { ...item, location: "Remote - India" });
  assert.equal(p.isRemote, true);
});

test("listPostings returns a single short page as-is", async () => {
  const page1 = { count: 2, items: [item, { ...item, job_ad_id: 2, title: "Data Engineer" }] };
  stubFetchSeq([() => jsonResponse(page1)]);
  try {
    const posts = await digitalRecruitersAdapter.listPostings(company);
    assert.deepEqual(posts.map((p) => p.externalId), ["4457689", "2"]);
  } finally {
    restoreFetch();
  }
});

test("listPostings paginates across full pages until the count is reached", async () => {
  // Server honors limit=100: a full page means "more may follow"; pagination stops on the first short page.
  const full = Array.from({ length: 100 }, (_, i) => ({ ...item, job_ad_id: i + 1 }));
  const tail = Array.from({ length: 50 }, (_, i) => ({ ...item, job_ad_id: 101 + i }));
  stubFetchSeq([
    () => jsonResponse({ count: 150, items: full }),
    () => jsonResponse({ count: 150, items: tail }),
  ]);
  try {
    const posts = await digitalRecruitersAdapter.listPostings(company);
    assert.equal(posts.length, 150);
    assert.equal(at(posts, 0).externalId, "1");
    assert.equal(at(posts, 149).externalId, "150");
  } finally {
    restoreFetch();
  }
});

test("listPostings throws a clear error when apiMeta.domainName is missing", async () => {
  const c: AdapterCompany = { ...company, apiMeta: {} };
  await assert.rejects(digitalRecruitersAdapter.listPostings(c), /apiMeta\.domainName/);
});

test("fetchJd concatenates description + profile and strips HTML", async () => {
  stubFetchSeq([() => jsonResponse({ description: "<p>Build <b>services</b></p>", profile: "<p>5y Java</p>" })]);
  try {
    const jd = await fetchJd(company, normalizeDigitalRecruiters(company, m, item));
    assert.match(jd, /Build services/);
    assert.match(jd, /5y Java/);
    assert.doesNotMatch(jd, /<p>|<b>/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd tolerates an {item:{...}} envelope", async () => {
  stubFetchSeq([() => jsonResponse({ item: { description: "<p>Own growth</p>", profile: null } })]);
  try {
    const jd = await fetchJd(company, normalizeDigitalRecruiters(company, m, item));
    assert.match(jd, /Own growth/);
  } finally {
    restoreFetch();
  }
});

test("fetchJd returns empty string (not a throw) on a malformed detail response", async () => {
  stubFetchSeq([() => jsonResponse({ unexpected: true })]);
  try {
    const jd = await fetchJd(company, normalizeDigitalRecruiters(company, m, item));
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
});
