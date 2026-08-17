import { test } from "node:test";
import assert from "node:assert/strict";
import { extractYcDataPage, ycJobsFromListPage, ycJobFromDetailPage, ycJobsPageUrl, ycJobUrl, normalizeYc, parseYcRelative, YcJobListingSchema } from "../ycombinator.js";
import type { YcJobListing } from "../ycombinator.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "ycombinator",
  slug: "landeed",
  name: "Landeed",
  careersUrl: "https://www.ycombinator.com/companies/landeed/jobs",
  tenantUrl: null,
  apiMeta: null,
};

// Trimmed real jobPostings[0] shape, still HTML-attribute-escaped the way YC's SSR emits it in data-page="...".
const LIST_PAGE_HTML = `<div id="WaasShowJobsPage-react-component-abc" data-page="{&quot;component&quot;:&quot;WaasShowJobsPage&quot;,&quot;props&quot;:{&quot;company&quot;:{&quot;id&quot;:27252,&quot;slug&quot;:&quot;landeed&quot;,&quot;name&quot;:&quot;Landeed&quot;},&quot;jobPostings&quot;:[{&quot;id&quot;:95916,&quot;title&quot;:&quot;Member of Technical Staff - Post-Training Engineer&quot;,&quot;url&quot;:&quot;/companies/landeed/jobs/GL2b1aZ-member-of-technical-staff-post-training-engineer&quot;,&quot;location&quot;:&quot;Hyderabad, TS, IN / Hyderabad, Telangana, IN&quot;,&quot;type&quot;:&quot;Full-time&quot;,&quot;createdAt&quot;:&quot;about 1 month&quot;,&quot;lastActive&quot;:&quot;28 days&quot;},{&quot;id&quot;:64084,&quot;title&quot;:&quot;Performance Marketing Associate&quot;,&quot;url&quot;:&quot;/companies/material-depot/jobs/xtGGo2v-performance-marketing-associate&quot;,&quot;location&quot;:&quot;Remote&quot;,&quot;type&quot;:&quot;Full-time&quot;,&quot;createdAt&quot;:&quot;over 2 years&quot;}]}}">`;

// Trimmed real detail-page shape from ycombinator.com/companies/landeed/jobs/<slug>.
const DETAIL_PAGE_HTML = `<div id="WaasShowJobPage-react-component-def" data-page="{&quot;component&quot;:&quot;WaasShowJobPage&quot;,&quot;props&quot;:{&quot;company&quot;:{&quot;slug&quot;:&quot;landeed&quot;},&quot;job&quot;:{&quot;id&quot;:95916,&quot;title&quot;:&quot;Member of Technical Staff - Post-Training Engineer&quot;,&quot;description&quot;:&quot;## The Role\\n\\nYou&#x27;ll own post-training end to end.\\n\\n* Bullet one\\n* Bullet two&quot;}}}">`;

test("extractYcDataPage decodes the entity-escaped data-page attribute and parses the JSON island", () => {
  const data = extractYcDataPage(LIST_PAGE_HTML);
  assert.ok(data && typeof data === "object");
});

test("extractYcDataPage returns null when no data-page attribute is present", () => {
  assert.equal(extractYcDataPage("<html><body>nothing here</body></html>"), null);
});

test("ycJobsFromListPage unwraps props.jobPostings and validates each item", () => {
  const data = extractYcDataPage(LIST_PAGE_HTML);
  const jobs = ycJobsFromListPage(data, "landeed");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.title, "Member of Technical Staff - Post-Training Engineer");
  assert.equal(jobs[0].location, "Hyderabad, TS, IN / Hyderabad, Telangana, IN");
});

test("ycJobsFromListPage throws on a schema mismatch (e.g. missing jobPostings)", () => {
  assert.throws(() => ycJobsFromListPage({ props: {} }, "landeed"));
});

test("YcJobListingSchema requires id, title, url and tolerates missing location/createdAt", () => {
  assert.ok(YcJobListingSchema.safeParse({ id: 1, title: "x", url: "/y" }).success);
  assert.equal(YcJobListingSchema.safeParse({ title: "no id or url" }).success, false);
});

test("ycJobsPageUrl builds the company's public jobs board URL from its slug", () => {
  assert.equal(ycJobsPageUrl(company), "https://www.ycombinator.com/companies/landeed/jobs");
});

test("ycJobUrl resolves a site-relative listing url against the YC origin", () => {
  assert.equal(
    ycJobUrl("/companies/landeed/jobs/GL2b1aZ-member-of-technical-staff-post-training-engineer"),
    "https://www.ycombinator.com/companies/landeed/jobs/GL2b1aZ-member-of-technical-staff-post-training-engineer",
  );
});

test("ycJobUrl leaves an already-absolute URL untouched", () => {
  assert.equal(ycJobUrl("https://example.com/x"), "https://example.com/x");
});

test("parseYcRelative parses date-fns-style relative strings, ignoring the qualifier word", () => {
  const now = Date.now();
  const aboutMonth = parseYcRelative("about 1 month");
  assert.ok(aboutMonth);
  const deltaDays = (now - new Date(aboutMonth).getTime()) / 86_400_000;
  assert.ok(deltaDays > 29 && deltaDays < 31);

  const overYears = parseYcRelative("over 2 years");
  assert.ok(overYears);
  const deltaYears = (now - new Date(overYears).getTime()) / (365 * 86_400_000);
  assert.ok(deltaYears > 1.9 && deltaYears < 2.1);
});

test("parseYcRelative returns null for unparseable or missing strings", () => {
  assert.equal(parseYcRelative("less than a minute"), null);
  assert.equal(parseYcRelative(null), null);
  assert.equal(parseYcRelative(undefined), null);
});

test("normalizeYc maps fields: absolute jobUrl, remote detection, empty jdText for fetchJd to fill", () => {
  const listing: YcJobListing = {
    id: 95916,
    title: "Member of Technical Staff - Post-Training Engineer",
    url: "/companies/landeed/jobs/GL2b1aZ-member-of-technical-staff-post-training-engineer",
    location: "Hyderabad, TS, IN / Hyderabad, Telangana, IN",
    createdAt: "about 1 month",
  };
  const p = normalizeYc(company, listing);
  assert.equal(p.provider, "ycombinator");
  assert.equal(p.externalId, "95916");
  assert.equal(p.companySlug, "landeed");
  assert.equal(
    p.jobUrl,
    "https://www.ycombinator.com/companies/landeed/jobs/GL2b1aZ-member-of-technical-staff-post-training-engineer",
  );
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.ok(p.postedAt);
});

test("normalizeYc detects a Remote location string", () => {
  const listing: YcJobListing = {
    id: 64084,
    title: "Performance Marketing Associate",
    url: "/companies/material-depot/jobs/xtGGo2v-performance-marketing-associate",
    location: "Remote",
  };
  const p = normalizeYc(company, listing);
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, null); // no createdAt supplied
});

test("detail-page data-page extraction yields the full JD via ycJobFromDetailPage", () => {
  const data = extractYcDataPage(DETAIL_PAGE_HTML);
  const job = ycJobFromDetailPage(data, "landeed", "95916");
  assert.ok(job);
  assert.match(job.description ?? "", /own post-training end to end/);
  assert.match(job.description ?? "", /You'll own/);
});

test("ycJobFromDetailPage returns null (not throw) on a schema mismatch", () => {
  assert.equal(ycJobFromDetailPage({ props: {} }, "landeed", "95916"), null);
});
