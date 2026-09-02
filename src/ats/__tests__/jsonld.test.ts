import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonldAdapter, isJobDetailUrl, titleFromUrl } from "../jsonld.js";
import { stubFetch, fetchSequence, htmlResponse, mkAdapterCompany } from "./testHelpers.js";
import type { NormalizedPosting } from "../../types.js";

/** Route-map fetch stub: serves a canned Response per exact URL, 404s anything unlisted (harmless — the
 *  adapter's discovery fetches are all wrapped to degrade to null on failure). Records call order when
 *  `calls` is passed, for tests that care which URLs were (or weren't) fetched. */
function mapFetch(routes: Record<string, () => Response>, calls?: string[]): typeof globalThis.fetch {
  return async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls?.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
}

function mkPosting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    provider: "jsonld",
    externalId: "acme.example/careers/role",
    companySlug: "acme",
    companyName: "Acme",
    jobTitle: "Provisional Title",
    jobUrl: "https://acme.example/careers/role",
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
    ...overrides,
  };
}

const COMPANY = mkAdapterCompany(
  { provider: "jsonld", slug: "acme", name: "Acme", careersUrl: "https://acme.example/careers" },
  { tenantUrl: "https://acme.example" },
);

// --- discovery: robots.txt -> sitemap INDEX -> sub-sitemaps (job-matching ones first) ---

test("listPostings follows robots.txt Sitemap: into a sitemap INDEX, fetching job-matching sub-sitemaps before others, and excludes asset/nav URLs", async (t) => {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    "https://acme.example/robots.txt": () =>
      new Response("User-agent: *\nSitemap: https://acme.example/sitemap-index.xml\n", { status: 200 }),
    "https://acme.example/sitemap-index.xml": () =>
      new Response(
        `<?xml version="1.0"?><sitemapindex>
          <sitemap><loc>https://acme.example/sitemap-careers.xml</loc></sitemap>
          <sitemap><loc>https://acme.example/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`,
        { status: 200, headers: { "Content-Type": "application/xml" } },
      ),
    "https://acme.example/sitemap-careers.xml": () =>
      new Response(
        `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.example/careers/software-engineer-backend</loc></url>
          <url><loc>https://acme.example/careers/product-designer</loc></url>
          <url><loc>https://acme.example/careers/search?q=engineer</loc></url>
          <url><loc>https://acme.example/careers/brochure.pdf</loc></url>
          <url><loc>https://acme.example/about-us</loc></url>
          <url><loc>https://acme.example/apply?jobid=4821</loc></url>
        </urlset>`,
        { status: 200, headers: { "Content-Type": "application/xml" } },
      ),
    "https://acme.example/sitemap-pages.xml": () =>
      new Response(
        `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.example/careers/growth-marketer</loc></url>
          <url><loc>https://acme.example/privacy-policy</loc></url>
        </urlset>`,
        { status: 200, headers: { "Content-Type": "application/xml" } },
      ),
  };
  stubFetch(t, mapFetch(routes, calls));

  const postings = await jsonldAdapter.listPostings(COMPANY);
  const urls = postings.map((p) => p.jobUrl).sort();
  assert.deepEqual(urls, [
    "https://acme.example/apply?jobid=4821",
    "https://acme.example/careers/growth-marketer",
    "https://acme.example/careers/product-designer",
    "https://acme.example/careers/software-engineer-backend",
  ]);

  // Job-matching sub-sitemap fetched before the non-matching one.
  const careersIdx = calls.indexOf("https://acme.example/sitemap-careers.xml");
  const pagesIdx = calls.indexOf("https://acme.example/sitemap-pages.xml");
  assert.ok(careersIdx >= 0 && pagesIdx >= 0 && careersIdx < pagesIdx);
});

test("listPostings falls back to careers-page anchor harvest when <3 sitemap job URLs are found, resolving relative hrefs and stopping once 3 are found", async (t) => {
  const calls: string[] = [];
  const company = mkAdapterCompany(
    { provider: "jsonld", slug: "beta", name: "Beta", careersUrl: "https://beta.example/careers" },
    { tenantUrl: "https://beta.example" },
  );
  const routes: Record<string, () => Response> = {
    "https://beta.example/sitemap.xml": () =>
      new Response(
        `<?xml version="1.0"?><urlset><url><loc>https://beta.example/careers/existing-role</loc></url></urlset>`,
        { status: 200, headers: { "Content-Type": "application/xml" } },
      ),
    "https://beta.example/careers": () =>
      htmlResponse(`
        <html><body>
          <a href="/careers/jobs/frontend-developer">Frontend Developer</a>
          <a href="jobs/backend-engineer">Backend Engineer</a>
          <a href="/careers/jobs/qa-engineer">QA Engineer</a>
          <a href="/about">About Us</a>
        </body></html>
      `),
  };
  stubFetch(t, mapFetch(routes, calls));

  const postings = await jsonldAdapter.listPostings(company);
  const urls = postings.map((p) => p.jobUrl).sort();
  assert.deepEqual(urls, [
    "https://beta.example/careers/existing-role",
    "https://beta.example/careers/jobs/frontend-developer",
    "https://beta.example/careers/jobs/qa-engineer",
    "https://beta.example/jobs/backend-engineer",
  ]);

  // Stopped after /careers (3 found there) — the second fallback path (/jobs) was never fetched.
  assert.ok(!calls.includes("https://beta.example/jobs"));
});

test("listPostings returns [] when discovery finds nothing anywhere, without throwing", async (t) => {
  const company = mkAdapterCompany(
    { provider: "jsonld", slug: "gamma", name: "Gamma", careersUrl: "https://gamma.example/careers" },
    { tenantUrl: "https://gamma.example" },
  );
  stubFetch(t, mapFetch({}));
  const postings = await jsonldAdapter.listPostings(company);
  assert.deepEqual(postings, []);
});

// --- titleFromUrl de-slugging ---

test("titleFromUrl de-slugs the last path segment into Title Case", () => {
  assert.equal(titleFromUrl("https://acme.example/careers/senior-software-engineer-38291"), "Senior Software Engineer");
  assert.equal(titleFromUrl("https://acme.example/careers/qa-engineer.html"), "Qa Engineer");
  assert.equal(titleFromUrl("https://acme.example/jobs/product%20manager"), "Product Manager");
  assert.equal(titleFromUrl("https://acme.example/careers/engineer_2_backend"), "Engineer 2 Backend");
});

test("titleFromUrl falls back to '(position)' for an empty or purely-numeric slug", () => {
  assert.equal(titleFromUrl("https://acme.example/"), "(position)");
  assert.equal(titleFromUrl("https://acme.example/jobs/48213"), "(position)");
});

test("titleFromUrl caps the title at 140 chars", () => {
  const longSlug = Array.from({ length: 30 }, () => "word").join("-");
  const title = titleFromUrl(`https://acme.example/careers/${longSlug}`);
  assert.ok(title.length <= 140);
});

// --- isJobDetailUrl ---

test("isJobDetailUrl accepts job-shaped paths and jobid-ish query params, rejects assets and nav paths", () => {
  assert.equal(isJobDetailUrl("https://acme.example/careers/software-engineer"), true);
  assert.equal(isJobDetailUrl("https://acme.example/jobs/qa-lead"), true);
  assert.equal(isJobDetailUrl("https://acme.example/apply?jobid=123"), true);
  assert.equal(isJobDetailUrl("https://acme.example/apply?reqId=abc"), true);
  assert.equal(isJobDetailUrl("https://acme.example/careers/brochure.pdf"), false);
  assert.equal(isJobDetailUrl("https://acme.example/careers/search?q=x"), false);
  assert.equal(isJobDetailUrl("https://acme.example/careers"), false);
  assert.equal(isJobDetailUrl("not a url"), false);
});

// --- fetchJd: JSON-LD JobPosting extraction ---

test("fetchJd reads a bare JobPosting object and refines title/location/postedAt", async (t) => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Backend Engineer",
    description: "<p>Build things.</p>",
    datePosted: "2026-08-01",
    jobLocation: {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: "Bengaluru", addressRegion: "Karnataka", addressCountry: "India" },
    },
  })}</script></head><body></body></html>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);

  assert.equal(jd, "Build things.");
  assert.equal(posting.jobTitle, "Backend Engineer");
  assert.equal(posting.location, "Bengaluru, Karnataka, India");
  assert.equal(posting.postedAt, new Date("2026-08-01").toISOString());
  assert.equal(posting.isRemote, false);
});

test("fetchJd finds the JobPosting node inside an array of nodes", async (t) => {
  const html = `<script type="application/ld+json">${JSON.stringify([
    { "@type": "Organization", name: "Acme" },
    { "@type": "JobPosting", title: "Data Analyst", description: "Analyze data." },
  ])}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(jd, "Analyze data.");
  assert.equal(posting.jobTitle, "Data Analyst");
});

test("fetchJd finds the JobPosting node inside an @graph wrapper", async (t) => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage" }, { "@type": "JobPosting", title: "QA Lead", description: "Test stuff." }],
  })}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(jd, "Test stuff.");
  assert.equal(posting.jobTitle, "QA Lead");
});

test("fetchJd matches a node whose @type is an array containing JobPosting", async (t) => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": ["JobPosting", "Posting"],
    title: "SRE",
    description: "On call.",
  })}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(jd, "On call.");
  assert.equal(posting.jobTitle, "SRE");
});

test("fetchJd sets isRemote and a Remote - <names> location for TELECOMMUTE postings", async (t) => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Remote Dev",
    description: "Work anywhere.",
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: [
      { "@type": "Country", name: "India" },
      { "@type": "Country", name: "United States" },
    ],
  })}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(posting.isRemote, true);
  assert.equal(posting.location, "Remote - India; United States");
});

test("fetchJd joins multiple jobLocation entries, capped at 4", async (t) => {
  const locations = ["City1", "City2", "City3", "City4", "City5"].map((city) => ({
    "@type": "Place",
    address: { "@type": "PostalAddress", addressLocality: city, addressCountry: "Country" },
  }));
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Multi-site Role",
    description: "Travels a lot.",
    jobLocation: locations,
  })}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(posting.location, "City1, Country; City2, Country; City3, Country; City4, Country");
});

test("fetchJd returns '' and leaves the posting untouched when the page has no JobPosting JSON-LD", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse("<html><body><p>No structured data here.</p></body></html>")));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(jd, "");
  assert.equal(posting.jobTitle, "Provisional Title");
  assert.equal(posting.location, null);
  assert.equal(posting.isRemote, false);
  assert.equal(posting.postedAt, null);
});

test("fetchJd returns '' and leaves the posting untouched when the JobPosting node has no description", async (t) => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "No Description Role",
  })}</script>`;
  stubFetch(t, fetchSequence(() => htmlResponse(html)));

  const posting = mkPosting();
  const jd = await jsonldAdapter.fetchJd?.(COMPANY, posting);
  assert.equal(jd, "");
  assert.equal(posting.jobTitle, "Provisional Title");
});
