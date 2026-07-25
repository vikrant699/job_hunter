// src/ats/peerlist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPeerlistNextData,
  parsePeerlistPageProps,
  peerlistExternalId,
  peerlistJobUrl,
  peerlistLocationText,
  normalizePeerlistItem,
  peerlistAdapter,
  PEERLIST_BOARD_URL,
} from "./peerlist.js";
import type { PeerlistJobLike } from "./peerlist.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "peerlist", slug: "peerlist", name: "Peerlist",
  careersUrl: PEERLIST_BOARD_URL, tenantUrl: null, apiMeta: null,
};

function pageHtml(pageProps: unknown): string {
  const nextData = {
    props: { pageProps },
    page: "/",
    query: {},
    buildId: "TESTBUILD",
  };
  return `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

// Real shape captured live 2026-07-12 from careers.peerlist.io/ — the board
// is live but has zero open postings today (companyData trimmed here to the
// fields that matter; the real payload also carries logo/socialLinks/tools/
// images/integrations, none of which this adapter reads).
const REAL_EMPTY_ISLAND_HTML = pageHtml({
  companyData: { name: "Peerlist", domain: "peerlist.io", profileHandle: "peerlist" },
  careersList: [],
  jobData: null,
  embed: false,
  isCustomDomain: true,
});

// Synthetic — no live board has openings today, so this exercises the
// tolerant per-item schema with two different alias sets: job A uses
// id/title/location-as-string/description; job B uses slug/role/location-as-
// an-array-of-{city,country}/jobDescription.
const SYNTHETIC_TWO_JOBS_HTML = pageHtml({
  companyData: { name: "Acme" },
  careersList: [
    {
      id: 42,
      title: "Frontend Engineer",
      location: "Bengaluru, India",
      description: "<p>Build our UI.</p>",
    },
    {
      slug: "backend-engineer-remote",
      role: "Backend Engineer",
      location: [{ city: "Remote", country: "India" }],
      jobDescription: "<p>Own our APIs.</p>",
    },
  ],
  jobData: null,
  embed: false,
  isCustomDomain: true,
});

test("extractPeerlistNextData parses the __NEXT_DATA__ island", () => {
  const data = extractPeerlistNextData(REAL_EMPTY_ISLAND_HTML);
  assert.ok(data && typeof data === "object");
});

test("extractPeerlistNextData returns null when the island is missing (site redesign)", () => {
  assert.equal(extractPeerlistNextData("<html><body>no island here</body></html>"), null);
});

test("extractPeerlistNextData returns null on malformed JSON inside the island", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{not valid json</script>`;
  assert.equal(extractPeerlistNextData(html), null);
});

test("parsePeerlistPageProps unwraps an empty careersList from the real live shape", () => {
  const data = extractPeerlistNextData(REAL_EMPTY_ISLAND_HTML);
  const props = parsePeerlistPageProps(data, "peerlist");
  assert.deepEqual(props.careersList, []);
  assert.equal(props.jobData, null);
});

test("parsePeerlistPageProps unwraps the synthetic two-job careersList", () => {
  const data = extractPeerlistNextData(SYNTHETIC_TWO_JOBS_HTML);
  const props = parsePeerlistPageProps(data, "acme");
  assert.equal(props.careersList.length, 2);
  assert.equal(props.careersList[0]?.title, "Frontend Engineer");
  assert.equal(props.careersList[1]?.role, "Backend Engineer");
});

test("parsePeerlistPageProps throws a labeled error on an unrecognizable shape", () => {
  assert.throws(() => parsePeerlistPageProps({ nope: true }, "acme"), /peerlist __NEXT_DATA__ response failed schema for acme/);
});

test("peerlistExternalId prefers id, then jobId, then slug, then a slugified title", () => {
  assert.equal(peerlistExternalId({ id: 42 }), "42");
  assert.equal(peerlistExternalId({ jobId: "J-1" }), "J-1");
  assert.equal(peerlistExternalId({ slug: "backend-engineer" }), "backend-engineer");
  assert.equal(peerlistExternalId({ title: "Product Designer" }), "product-designer");
});

test("peerlistJobUrl prefers slug over id, and falls back to the board URL with neither", () => {
  assert.equal(peerlistJobUrl({ slug: "backend-engineer-remote", id: 1 }), "https://careers.peerlist.io/backend-engineer-remote");
  assert.equal(peerlistJobUrl({ id: 42 }), "https://careers.peerlist.io/42");
  assert.equal(peerlistJobUrl({}), PEERLIST_BOARD_URL);
});

test("peerlistLocationText handles a plain string, an array of {city,country}, and null", () => {
  assert.equal(peerlistLocationText("Bengaluru, India"), "Bengaluru, India");
  assert.equal(peerlistLocationText([{ city: "Remote", country: "India" }]), "Remote, India");
  assert.equal(peerlistLocationText(null), null);
  assert.equal(peerlistLocationText(undefined), null);
});

test("normalizePeerlistItem maps the id/title/string-location/description alias set", () => {
  const item: PeerlistJobLike = { id: 42, title: "Frontend Engineer", location: "Bengaluru, India", description: "<p>Build our UI.</p>" };
  const p = normalizePeerlistItem(company, item);
  assert.equal(p.provider, "peerlist");
  assert.equal(p.externalId, "42");
  assert.equal(p.jobTitle, "Frontend Engineer");
  assert.equal(p.jobUrl, "https://careers.peerlist.io/42");
  assert.equal(p.location, "Bengaluru, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "Build our UI.");
  assert.equal(p.postedAt, null);
});

test("normalizePeerlistItem maps the slug/role/array-location/jobDescription alias set and flags remote", () => {
  const item: PeerlistJobLike = {
    slug: "backend-engineer-remote",
    role: "Backend Engineer",
    location: [{ city: "Remote", country: "India" }],
    jobDescription: "<p>Own our APIs.</p>",
  };
  const p = normalizePeerlistItem(company, item);
  assert.equal(p.externalId, "backend-engineer-remote");
  assert.equal(p.jobTitle, "Backend Engineer");
  assert.equal(p.jobUrl, "https://careers.peerlist.io/backend-engineer-remote");
  assert.equal(p.location, "Remote, India");
  assert.equal(p.isRemote, true);
  assert.equal(p.jdText, "Own our APIs.");
});

test("normalizePeerlistItem falls back to 'Untitled' and null location/jdText='' with a bare item", () => {
  const p = normalizePeerlistItem(company, {});
  assert.equal(p.jobTitle, "Untitled");
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
});

// --- adapter-level: real empty board, synthetic non-empty board, missing island ---

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("peerlistAdapter.listPostings returns [] against the real live (empty) board island", async () => {
  stubFetch(async () => new Response(REAL_EMPTY_ISLAND_HTML, { status: 200 }));
  try {
    const postings = await peerlistAdapter.listPostings(company);
    assert.deepEqual(postings, []);
  } finally {
    restoreFetch();
  }
});

test("peerlistAdapter.listPostings maps both jobs against the synthetic two-job board island", async () => {
  stubFetch(async () => new Response(SYNTHETIC_TWO_JOBS_HTML, { status: 200 }));
  try {
    const postings = await peerlistAdapter.listPostings(company);
    assert.equal(postings.length, 2);
    assert.deepEqual(postings.map((p) => p.jobTitle), ["Frontend Engineer", "Backend Engineer"]);
  } finally {
    restoreFetch();
  }
});

test("peerlistAdapter.listPostings throws when the __NEXT_DATA__ island is missing entirely (site redesign)", async () => {
  stubFetch(async () => new Response("<html><body>redesigned, no island</body></html>", { status: 200 }));
  try {
    await assert.rejects(peerlistAdapter.listPostings(company), /no __NEXT_DATA__ island/);
  } finally {
    restoreFetch();
  }
});

test("peerlistAdapter.fetchJd reads jobData's description from the job's own page island", async () => {
  const jobPageHtml = pageHtml({
    companyData: { name: "Acme" },
    careersList: null,
    jobData: { id: 42, title: "Frontend Engineer", description: "<p>Full JD here.</p>" },
    embed: false,
    isCustomDomain: true,
  });
  stubFetch(async () => new Response(jobPageHtml, { status: 200 }));
  try {
    const posting = normalizePeerlistItem(company, { id: 42, title: "Frontend Engineer", location: "Bengaluru, India" });
    const jd = await peerlistAdapter.fetchJd!(company, posting);
    assert.equal(jd, "Full JD here.");
  } finally {
    restoreFetch();
  }
});

test("peerlistAdapter.fetchJd returns '' when the job page has no jobData at all", async () => {
  stubFetch(async () => new Response(REAL_EMPTY_ISLAND_HTML, { status: 200 }));
  try {
    const posting = normalizePeerlistItem(company, { id: 42, title: "Frontend Engineer" });
    const jd = await peerlistAdapter.fetchJd!(company, posting);
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
});
