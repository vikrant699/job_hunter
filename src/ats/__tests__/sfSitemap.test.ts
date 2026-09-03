import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSfSitemapIds, parseSfSitemapUrlset, titleFromSitemapUrl } from "../sfSitemap.js";
import { htmlResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company = mkAdapterCompany({
  provider: "sfcsb",
  slug: "payu",
  name: "PayU",
  careersUrl: "https://careers.payu.in",
}, { tenantUrl: "https://careers.payu.in" });

// Modeled on a real PayU sitemap.xml entry, plus a non-job <loc> that must be excluded and an end-of-string (no trailing slash) id variant.
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
  // no-trailing-slash variant
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
