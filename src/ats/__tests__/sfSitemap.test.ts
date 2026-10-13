import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSfSitemapIds, parseSfSitemapUrlset, sitemapOnlyEntries, titleFromSitemapUrl } from "../sfSitemap.js";
import { captureLogs } from "../../__tests__/logCapture.js";
import { htmlResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company = mkAdapterCompany({
  provider: "sfcsb",
  slug: "payu",
  name: "PayU",
  careersUrl: "https://careers.payu.in",
}, { tenantUrl: "https://careers.payu.in" });

// Includes a non-job <loc> that must be excluded and an end-of-string (no trailing slash) id.
const URLSET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://careers.payu.in/PayU/job/Gurgaon-P3-Assistant-Manager-BSM/53951080/</loc><lastmod>2026-08-29</lastmod></url>
  <url><loc>https://careers.payu.in/PayU/job/Mumbai-Growth-Manager/53951081/</loc><lastmod>2026-08-29</lastmod></url>
  <url><loc>https://careers.payu.in/PayU/job/Bangalore-Data-Engineer/53951082</loc><lastmod>2026-08-29</lastmod></url>
  <url><loc>https://careers.payu.in/PayU/content/page/about-us</loc><lastmod>2026-08-29</lastmod></url>
</urlset>`;

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>PayU Jobs</title></channel></rss>`;

test("parseSfSitemapUrlset maps /job/.../<digits>/ locs to id -> url, dropping non-job locs", () => {
  const ids = parseSfSitemapUrlset(URLSET_XML);
  assert.equal(ids.size, 3);
  assert.equal(ids.get("53951080"), "https://careers.payu.in/PayU/job/Gurgaon-P3-Assistant-Manager-BSM/53951080/");
  assert.equal(ids.get("53951081"), "https://careers.payu.in/PayU/job/Mumbai-Growth-Manager/53951081/");
  assert.equal(ids.get("53951082"), "https://careers.payu.in/PayU/job/Bangalore-Data-Engineer/53951082");
});

test("titleFromSitemapUrl de-kebabs and title-cases the slug segment before the id", () => {
  assert.equal(
    titleFromSitemapUrl("https://careers.payu.in/PayU/job/Gurgaon-P3-Assistant-Manager-BSM/53951080/"),
    "Gurgaon P3 Assistant Manager Bsm",
  );
  assert.equal(
    titleFromSitemapUrl("https://careers.payu.in/PayU/job/Mumbai-Growth-Manager/53951081/"),
    "Mumbai Growth Manager",
  );
});

test("fetchSfSitemapIds parses a live urlset into the id -> url map", async (t) => {
  stubFetch(t, (input) => {
    assert.equal(String(input), "https://careers.payu.in/sitemap.xml");
    return Promise.resolve(htmlResponse(URLSET_XML));
  });
  const ids = await fetchSfSitemapIds(company, "sfcsb");
  assert.ok(ids);
  assert.equal(ids.size, 3);
});

test("fetchSfSitemapIds returns null (never throws) on an <rss> feed variant", async (t) => {
  stubFetch(t, () => Promise.resolve(htmlResponse(RSS_XML)));
  const ids = await fetchSfSitemapIds(company, "sfcsb");
  assert.equal(ids, null);
});

test("fetchSfSitemapIds returns null on an HTTP error", async (t) => {
  stubFetch(t, () => Promise.resolve(htmlResponse("not found", 404)));
  const ids = await fetchSfSitemapIds(company, "sfcsb");
  assert.equal(ids, null);
});

test("fetchSfSitemapIds returns null on a non-XML body (no urlset, no rss)", async (t) => {
  stubFetch(t, () => Promise.resolve(htmlResponse("<html><body>parked</body></html>")));
  const ids = await fetchSfSitemapIds(company, "sfcsb");
  assert.equal(ids, null);
});

test("fetchSfSitemapIds returns an empty (valid) map for an urlset with no job locs", async (t) => {
  stubFetch(t, () =>
    Promise.resolve(
      htmlResponse(
        `<urlset><url><loc>https://careers.payu.in/content/about</loc></url></urlset>`,
      ),
    ),
  );
  const ids = await fetchSfSitemapIds(company, "sfcsb");
  assert.ok(ids);
  assert.equal(ids.size, 0);
});

test("parseSfSitemapUrlset decodes XML entities in <loc> (a raw &amp; would leak into the job URL and title)", () => {
  const ids = parseSfSitemapUrlset(
    `<urlset><url><loc>https://careers.example.com/job/Data-&amp;-Analytics-Manager-NJ/60291944/</loc></url></urlset>`,
  );
  assert.equal(ids.get("60291944"), "https://careers.example.com/job/Data-&-Analytics-Manager-NJ/60291944/");
});

test("titleFromSitemapUrl percent-decodes the slug segment", () => {
  assert.equal(
    titleFromSitemapUrl("https://jobs.example.com/job/M%C3%BCnchen-Werksstudent-%28wmd%29-BY/1358878055/"),
    "München Werksstudent (wmd) By",
  );
  assert.equal(titleFromSitemapUrl("https://jobs.example.com/job/Bad-%E0-Escape/1/"), "Bad %e0 Escape");
});

test("sitemapOnlyEntries returns sitemap ids the listing never returned, in sitemap order", () => {
  const sitemap = new Map([
    ["1", "https://x.example/job/a/1/"],
    ["2", "https://x.example/job/b/2/"],
    ["3", "https://x.example/job/c/3/"],
  ]);
  assert.deepEqual(sitemapOnlyEntries(sitemap, new Set(["2"]), { slug: "x", provider: "sfcsb" }), [
    ["1", "https://x.example/job/a/1/"],
    ["3", "https://x.example/job/c/3/"],
  ]);
});

test("sitemapOnlyEntries stops at the runaway guard with a warning", async () => {
  const sitemap = new Map([
    ["1", "https://x.example/job/a/1/"],
    ["2", "https://x.example/job/b/2/"],
    ["3", "https://x.example/job/c/3/"],
  ]);
  let kept = 0;
  const lines = await captureLogs(() => {
    kept = sitemapOnlyEntries(sitemap, new Set(), { slug: "x", provider: "sfcsb" }, 2).length;
    return Promise.resolve();
  });
  assert.equal(kept, 2);
  assert.ok(lines.some((l) => l.level === "warn" && /runaway guard/.test(l.message ?? "")));
});

test("sitemapOnlyEntries keeps every sitemap-only id of a real-sized board (the old 500 cap truncated tuv-sud)", () => {
  const sitemap = new Map(Array.from({ length: 900 }, (_v, i) => [String(i), `https://x.example/job/r/${i}/`] as const));
  assert.equal(sitemapOnlyEntries(sitemap, new Set(["0"]), { slug: "x", provider: "sfcsb" }).length, 899);
});
