// src/ats/goodfit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  goodfitSlug,
  goodfitBoardUrl,
  extractGoodfitRedirect,
  extractGoodfitRscJobs,
  parseGoodfitLdItems,
  parseGoodfitBoard,
  extractGoodfitJd,
} from "./goodfit.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "goodfit",
  slug: "springworks",
  name: "Springworks",
  careersUrl: "https://app.goodfit.so/jobs/springworks",
  tenantUrl: null,
  apiMeta: null,
};

// --- fixtures, trimmed from live pages (captured 2026-07-11) ---

// v1 board shell for a migrated tenant: meta-refresh + RSC redirect template to v2.
const redirectShell = `<html><head><meta http-equiv="refresh" content="1;url=https://v2.app.goodfit.so/jobs/springworks"/></head>
<body><template data-msg="NEXT_REDIRECT;replace;https://v2.app.goodfit.so/jobs/springworks;307;"></template></body></html>`;

// v2 board: JSON-LD ItemList + RSC flight-data jobs island + rendered anchors.
const v2Board = `<html><body>
<script>self.__next_f.push([1,"3a:[\\"$\\",\\"$L3b\\",null,{\\"jobs\\":[{\\"id\\":\\"019eef20-821d-75ea-adee-7797343e5654\\",\\"title\\":\\"Legal Associate 1\\",\\"createdAt\\":\\"2026-06-22 11:39:05.63+00\\",\\"locations\\":[],\\"seniority\\":\\"junior\\",\\"tags\\":null,\\"slug\\":\\"9Zc1NHi6\\",\\"organization\\":{\\"name\\":\\"Springworks\\",\\"logo\\":\\"https://www.google.com/s2/favicons?domain=http://www.springworks.in\\u0026sz=128\\",\\"slug\\":\\"springworks\\"}},{\\"id\\":\\"019eca94-42ab-73eb-81c5-1a08a18b4135\\",\\"title\\":\\"Business Analyst\\",\\"createdAt\\":\\"2026-06-19 08:00:00+00\\",\\"locations\\":[\\"Chennai, Tamil Nadu, India\\"],\\"seniority\\":\\"mid\\",\\"tags\\":null,\\"slug\\":\\"x1y2z3\\",\\"organization\\":{\\"name\\":\\"Springworks\\",\\"slug\\":\\"springworks\\"}}]}]\\n"])</script>
<div hidden id="S:2">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","name":"Open positions at Springworks","numberOfItems":2,"itemListElement":[{"@type":"ListItem","position":1,"url":"https://v2.app.goodfit.so/jobs/springworks/Legal-Associate-1?id=019eef20-821d-75ea-adee-7797343e5654","name":"Legal Associate 1"},{"@type":"ListItem","position":2,"url":"https://v2.app.goodfit.so/jobs/springworks/Business-Analyst?id=019eca94-42ab-73eb-81c5-1a08a18b4135","name":"Business Analyst"}]}</script>
<a class="group flex" href="/jobs/springworks/Legal-Associate-1?id=019eef20-821d-75ea-adee-7797343e5654"><div><span class="font-medium text-base text-foreground">Legal Associate 1</span><div><span class="text-xs">Remote</span></div></div></a>
<a class="group flex" href="/jobs/springworks/Business-Analyst?id=019eca94-42ab-73eb-81c5-1a08a18b4135"><div><span class="font-medium text-base text-foreground">Business Analyst</span><div><span class="text-xs">Chennai</span></div></div></a>
</div></body></html>`;

// v1 board (non-migrated tenant, e.g. giva): server-rendered anchors, no JSON-LD.
const v1Board = `<html><body>
<a href="/jobs/giva/Store-Manager?id=oDD5zV-T" class="p-3 border rounded-lg block group"><div class="flex items-center gap-2 pr-2"><span class="size-10">GI</span><div class="flex-1"><div class="font-serif font-medium text-foreground leading-tight">Store Manager</div><div class="text-xs text-muted-foreground">Giva <span class="text-muted-foreground/50">✦</span> Bangalore, Karnataka, India</div></div></div><hr/><div class="text-sm!">As the Store Manager at Giva, you will drive the store.</div></a>
<a href="/jobs/giva/Retail-Trainer?id=rqKHHYbT" class="p-3 border rounded-lg block group"><div class="flex items-center gap-2 pr-2"><span class="size-10">GI</span><div class="flex-1"><div class="font-serif font-medium text-foreground leading-tight">Retail Trainer</div><div class="text-xs text-muted-foreground">Giva <span class="text-muted-foreground/50">✦</span> Hyderabad, Telangana, India</div></div></div></a>
</body></html>`;

// v2 detail page: JD inside a div.prose container.
const v2Detail = `<html><body><header>Springworks</header>
<div class="prose prose-neutral dark:prose-invert max-w-none"><p>About Springworks. We build SpringVerify, our B2B background verification platform, plus EngageWith and Goodfit.</p><ul><li>Draft and review contracts</li><li>Own compliance calendars</li></ul></div>
<footer>Powered by goodfit</footer></body></html>`;

// v1 detail page: JD inside a font-serif container styled with [&>h1] rules.
const v1Detail = `<html><body><h1>Store Manager</h1>
<div class="font-serif mt-6 max-w-3xl font-normal space-y-4 leading-relaxed [&amp;_strong]:font-semibold [&amp;&gt;h1]:text-2xl [&amp;&gt;p]:text-base"><p>As the Store Manager at Giva, you will be instrumental in driving the overall success of the store.</p><ul><li>Lead and manage the store team.</li></ul></div>
</body></html>`;

const notFound = `<html><body><script>self.__next_f.push([1,"26:E{\\"digest\\":\\"NEXT_HTTP_ERROR_FALLBACK;404\\"}\\n"])</script></body></html>`;

test("goodfitSlug takes the path segment after /jobs/, falling back to company slug", () => {
  assert.equal(goodfitSlug(company), "springworks");
  assert.equal(goodfitSlug({ ...company, careersUrl: "https://v2.app.goodfit.so/jobs/giva", slug: "x" }), "giva");
  assert.equal(goodfitSlug({ ...company, careersUrl: "https://example.com/", slug: "acme" }), "acme");
});

test("goodfitBoardUrl prefers tenantUrl, then careersUrl, then the canonical host", () => {
  assert.equal(goodfitBoardUrl(company), "https://app.goodfit.so/jobs/springworks");
  assert.equal(
    goodfitBoardUrl({ ...company, tenantUrl: "https://v2.app.goodfit.so/jobs/springworks" }),
    "https://v2.app.goodfit.so/jobs/springworks",
  );
  assert.equal(
    goodfitBoardUrl({ ...company, careersUrl: "https://example.com/", slug: "acme" }),
    "https://app.goodfit.so/jobs/acme",
  );
});

test("extractGoodfitRedirect finds the meta-refresh (and RSC template) target", () => {
  assert.equal(extractGoodfitRedirect(redirectShell), "https://v2.app.goodfit.so/jobs/springworks");
  const noMeta = redirectShell.replace(/<meta[^>]+>/, "");
  assert.equal(extractGoodfitRedirect(noMeta), "https://v2.app.goodfit.so/jobs/springworks");
  assert.equal(extractGoodfitRedirect(v1Board), null);
});

test("extractGoodfitRscJobs unescapes the flight-data island into an id map", () => {
  const map = extractGoodfitRscJobs(v2Board);
  assert.equal(map.size, 2);
  const legal = map.get("019eef20-821d-75ea-adee-7797343e5654");
  assert.ok(legal);
  assert.deepEqual(legal.locations, []);
  assert.equal(legal.createdAt, "2026-06-22 11:39:05.63+00");
  const ba = map.get("019eca94-42ab-73eb-81c5-1a08a18b4135");
  assert.deepEqual(ba?.locations, ["Chennai, Tamil Nadu, India"]);
  assert.equal(extractGoodfitRscJobs(v1Board).size, 0);
});

test("extractGoodfitRscJobs isn't confused by an unbalanced brace inside a job's own string field", () => {
  // A stray "}" inside the (unused-by-this-function) title field would have
  // thrown off the old string-blind brace counter, truncating the scan
  // before the real end of the array; the shared extractBalanced's
  // quote-tracking (post-unescape) correctly treats it as ordinary string
  // content instead.
  const withStrayBrace = `<html><body>
<script>self.__next_f.push([1,"3a:[\\"$\\",\\"$L3b\\",null,{\\"jobs\\":[{\\"id\\":\\"stray-1\\",\\"title\\":\\"Ops Level } One\\",\\"createdAt\\":\\"2026-01-01 00:00:00+00\\",\\"locations\\":[\\"Remote\\"]}]}]\\n"])</script>
</body></html>`;
  const map = extractGoodfitRscJobs(withStrayBrace);
  assert.equal(map.size, 1);
  const job = map.get("stray-1");
  assert.ok(job);
  assert.deepEqual(job.locations, ["Remote"]);
  assert.equal(job.createdAt, "2026-01-01 00:00:00+00");
});

test("parseGoodfitLdItems reads the ItemList JSON-LD", () => {
  const items = parseGoodfitLdItems(v2Board);
  assert.equal(items.length, 2);
  const item0 = at(items, 0);
  assert.equal(item0.name, "Legal Associate 1");
  assert.match(item0.url, /Legal-Associate-1\?id=019eef20/);
  assert.deepEqual(parseGoodfitLdItems(v1Board), []);
});

test("parseGoodfitBoard (v2) merges JSON-LD titles/urls with RSC locations + dates", () => {
  const postings = parseGoodfitBoard(v2Board, "https://v2.app.goodfit.so/jobs/springworks", company);
  assert.equal(postings.length, 2);
  const legal = at(postings, 0);
  const ba = at(postings, 1);
  assert.equal(legal.provider, "goodfit");
  assert.equal(legal.externalId, "019eef20-821d-75ea-adee-7797343e5654");
  assert.equal(legal.jobTitle, "Legal Associate 1");
  assert.equal(legal.jobUrl, "https://v2.app.goodfit.so/jobs/springworks/Legal-Associate-1?id=019eef20-821d-75ea-adee-7797343e5654");
  assert.equal(legal.location, null); // empty RSC locations -> null, NOT the board's "Remote" chip
  assert.equal(legal.postedAt, new Date("2026-06-22 11:39:05.63+00").toISOString());
  assert.equal(ba.location, "Chennai, Tamil Nadu, India");
  assert.equal(ba.jdText, "");
});

test("parseGoodfitBoard (v1) falls back to server-rendered anchors", () => {
  const postings = parseGoodfitBoard(v1Board, "https://app.goodfit.so/jobs/giva", { ...company, slug: "giva", name: "Giva" });
  assert.equal(postings.length, 2);
  const sm = at(postings, 0);
  const rt = at(postings, 1);
  assert.equal(sm.externalId, "oDD5zV-T");
  assert.equal(sm.jobTitle, "Store Manager");
  assert.equal(sm.location, "Bangalore, Karnataka, India");
  assert.equal(sm.jobUrl, "https://app.goodfit.so/jobs/giva/Store-Manager?id=oDD5zV-T");
  assert.equal(rt.jobTitle, "Retail Trainer");
  assert.equal(rt.location, "Hyderabad, Telangana, India");
});

test("parseGoodfitBoard throws on the 404 error page, returns [] for an empty board", () => {
  assert.throws(() => parseGoodfitBoard(notFound, "https://v2.app.goodfit.so/jobs/gone", company), /404/);
  assert.deepEqual(parseGoodfitBoard("<html><body>No openings</body></html>", "https://app.goodfit.so/jobs/x", company), []);
});

test("extractGoodfitJd pulls the prose container (v2) and the styled container (v1)", () => {
  const v2 = extractGoodfitJd(v2Detail);
  assert.match(v2, /background verification platform/);
  assert.match(v2, /Draft and review contracts/);
  assert.doesNotMatch(v2, /Powered by goodfit/);
  const v1 = extractGoodfitJd(v1Detail);
  assert.match(v1, /instrumental in driving the overall success/);
  assert.match(v1, /Lead and manage the store team/);
});

test("extractGoodfitJd falls back to whole-page text when no container matches", () => {
  const jd = extractGoodfitJd("<html><body><p>Plain description body.</p><script>ignored()</script></body></html>");
  assert.match(jd, /Plain description body/);
  assert.doesNotMatch(jd, /ignored/);
});
