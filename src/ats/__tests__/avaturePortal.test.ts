import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avaturePortalListUrl,
  listAvaturePortal,
  parseAvaturePortalList,
  parseAvaturePortalPage,
} from "../avaturePortal.js";
import { avatureAdapter } from "../avature.js";
import type { AdapterCompany } from "../../types.js";
import { asJson, at, htmlResponse, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany(
  { provider: "avature", slug: "sandisk", name: "SanDisk", careersUrl: "https://avature.sandisk.com/Careers/SearchJobs" },
);
const SEARCH_URL = "https://avature.sandisk.com/Careers/SearchJobs";

const LINKS = {
  jobDetailUrlCode: { targetPageId: null, pageParameters: [], isSecureUrl: true, detailJobTypeId: 1 },
  detailPage: { targetPageId: null, pageParameters: [{ key: "source", value: null }], isSecureUrl: false, detailJobTypeId: 1 },
};
const PROPS = {
  widgetId: "searchJobsList",
  uuid: "68b4f226-92b1-471e-8002-22d807cf6b32",
  hasToIncludePaginationOptions: false,
  allowListSorting: true,
  listType: "JobList",
  allowFilteringFromUrlParams: true,
  links: LINKS,
  dynamicValueConfigs: [],
  shouldAddBase64FileFields: false,
  searchMode: "ResultsAndCount",
  formId: "tpt_jobSortableForm",
  searchIndexId: 1,
  qtvc: "3249f91a4c726fbe",
  recordsPerPage: 6,
  layout: "custom",
  fetchJobIdInPeopleLists: true,
};

// The React-era portal: Avature meta, no article--result markup, a <list> widget whose props are signed by a session-bound qtvc.
const PORTAL_HTML = `
<html><head>
<meta name="avature.portal.id" content="13"/>
<meta name="avature.portal.urlPath" content="Careers"/>
</head><body>
  <list  data-props='${JSON.stringify(PROPS)}'></list>
</body></html>`;

const CLASSIC_HTML = `
<html><head><meta name="avature.portal.id" content="5"/></head><body>
  <article class="article article--result"><h3 class="article__header__text__title"><a href="/careers/JobDetail/1">x</a></h3></article>
</body></html>`;

function field(value: string, html?: string): { htmlValue: string; stringValue: string } {
  return { htmlValue: html ?? (value ? `<div class="field"><div class="field__value">${value}</div></div>` : ""), stringValue: value };
}

const COLUMNS = [
  { id: 1646, code: "nameWithoutLink", label: "Name without hyperlink" },
  { id: 1558, code: "postedDate", label: "Date" },
  { id: 1560, code: "schemaField_3_5_3", label: "Job Description" },
  { id: 1563, code: "name", label: "Name" },
  { id: 1564, code: "schemaField_3_198_3", label: "City" },
  { id: 1565, code: "schemaField_3_173_3", label: "State" },
  { id: 1566, code: "schemaField_3_114_3", label: "Country" },
  { id: 1622, code: "schemaField_3_201_3", label: "Work Mode" },
];
const DROPZONES = [
  { code: "Description", columns: [1560] },
  { code: "Title", columns: [1563] },
  { code: "SubTitle", columns: [1564, 1565, 1566] },
];

function result(id: number, title: string, city: string, country: string, workMode = "Employees work on-site") {
  return {
    id,
    entityId: id * 100,
    fields: {
      nameWithoutLink: field(title),
      name: field(title),
      postedDate: field("2026-10-13"),
      schemaField_3_5_3: field(`About ${title}`, `<div class="field__value"><p>About ${title}</p><ul><li>NVMe</li></ul></div>`),
      schemaField_3_198_3: field(city),
      schemaField_3_173_3: field(""),
      schemaField_3_114_3: field(country),
      schemaField_3_201_3: field(workMode),
    },
    dynamicValues: [],
  };
}

function listBody(results: ReturnType<typeof result>[], total: string | null, offset = 0) {
  return {
    results,
    offset,
    columns: COLUMNS,
    dropzones: DROPZONES,
    ...(total !== null ? { total } : {}),
    links: results.map((r) => ({
      jobDetailUrlCode: `https://avature.sandisk.com/Careers/JobDetail/Job-${r.id}/${r.id}?qtvc=abc`,
      detailPage: `https://avature.sandisk.com/Careers/JobDetail/Job-${r.id}/${r.id}`,
      applyPage: `https://avature.sandisk.com/Careers/ApplicationMethods?jobId=${r.id}`,
    })),
  };
}

function sessionResponse(): Response {
  const res = htmlResponse(PORTAL_HTML);
  res.headers.append("Set-Cookie", "ScustomPortal-13=sess123; path=/;SameSite=Strict; secure; HttpOnly");
  return res;
}

interface Call { url: string; cookie: string | null }

function recordingFetch(calls: Call[], responses: Array<() => Response>): typeof globalThis.fetch {
  let i = 0;
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, cookie: headers.get("cookie") });
    const next = responses[i];
    i++;
    if (!next) return Promise.reject(new Error(`unexpected fetch #${i}: ${url}`));
    return Promise.resolve(next());
  };
}

test("parseAvaturePortalPage reads the portal id and the JobList widget props", () => {
  const parsed = parseAvaturePortalPage(PORTAL_HTML);
  assert.ok(parsed);
  assert.equal(parsed.portalId, "13");
  assert.equal(parsed.props.uuid, PROPS.uuid);
  assert.equal(parsed.props.qtvc, PROPS.qtvc);
});

test("parseAvaturePortalPage returns null for a classic server-rendered portal", () => {
  assert.equal(parseAvaturePortalPage(CLASSIC_HTML), null);
  assert.equal(parseAvaturePortalPage("<html></html>"), null);
});

test("parseAvaturePortalPage ignores a non-JobList widget", () => {
  const html = PORTAL_HTML.replace('"listType":"JobList"', '"listType":"PeopleList"');
  assert.equal(parseAvaturePortalPage(html), null);
});

test("avaturePortalListUrl mirrors the signed widget config at /<portalId>/_portalList", () => {
  const parsed = parseAvaturePortalPage(PORTAL_HTML);
  assert.ok(parsed);
  const u = new URL(avaturePortalListUrl("https://avature.sandisk.com", parsed, 100, 50));
  assert.equal(u.origin + u.pathname, "https://avature.sandisk.com/13/_portalList");
  const q = u.searchParams;
  assert.equal(q.get("uuid"), PROPS.uuid);
  assert.equal(q.get("qtvc"), PROPS.qtvc);
  assert.equal(q.get("listType"), "JobList");
  assert.equal(q.get("offset"), "100");
  assert.equal(q.get("recordsPerPage"), "50");
  assert.equal(q.get("allowListSorting"), "true");
  assert.equal(q.get("shouldAddBase64FileFields"), "false");
  assert.equal(q.get("searchIndexId"), "1");
  assert.equal(q.get("formId"), "tpt_jobSortableForm");
  assert.deepEqual(JSON.parse(q.get("links") ?? "null"), LINKS);
  assert.equal(q.get("dynamicValueConfigs"), "[]");
  assert.equal(q.get("filters"), JSON.stringify({ search: "" }));
});

test("parseAvaturePortalList maps title, id, detail URL, labelled location columns, inline JD and date", () => {
  const body = listBody([result(3081, "Senior Staff Product Validation Engineer", "Bengaluru", "India")], "351");
  const { postings, total } = parseAvaturePortalList(asJson(body), company);
  assert.equal(total, 351);
  assert.equal(postings.length, 1);
  const p = at(postings, 0);
  assert.equal(p.provider, "avature");
  assert.equal(p.externalId, "3081");
  assert.equal(p.jobTitle, "Senior Staff Product Validation Engineer");
  assert.equal(p.jobUrl, "https://avature.sandisk.com/Careers/JobDetail/Job-3081/3081");
  assert.equal(p.location, "Bengaluru, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /About Senior Staff Product Validation Engineer/);
  assert.match(p.jdText, /NVMe/);
  assert.equal(p.postedAt, new Date("2026-10-13").toISOString());
  assert.equal(p.companySlug, "sandisk");
});

test("parseAvaturePortalList flags remote from the location or the work-mode column", () => {
  const body = listBody([
    result(1, "A", "Remote", "United States of America"),
    result(2, "B", "Bengaluru", "India", "Employees work remotely"),
  ], "2");
  const { postings } = parseAvaturePortalList(asJson(body), company);
  assert.equal(at(postings, 0).isRemote, true);
  assert.equal(at(postings, 1).isRemote, true);
});

test("parseAvaturePortalList matches a detail link by job id even when links are not index-aligned", () => {
  const body = listBody([result(7, "A", "Pune", "India"), result(8, "B", "Pune", "India")], "2");
  body.links.reverse();
  const { postings } = parseAvaturePortalList(asJson(body), company);
  assert.equal(at(postings, 0).jobUrl, "https://avature.sandisk.com/Careers/JobDetail/Job-7/7");
  assert.equal(at(postings, 1).jobUrl, "https://avature.sandisk.com/Careers/JobDetail/Job-8/8");
});

test("parseAvaturePortalList falls back to a bare JobDetail URL when the list carries no links", () => {
  const body = { ...listBody([result(9, "A", "Pune", "India")], "1"), links: [] };
  const { postings } = parseAvaturePortalList(asJson(body), company, SEARCH_URL);
  assert.equal(at(postings, 0).jobUrl, "https://avature.sandisk.com/Careers/JobDetail/9");
});

test("parseAvaturePortalList rejects a body that is not a list response", () => {
  assert.throws(() => parseAvaturePortalList(asJson("This list is private."), company), /schema/);
});

test("listAvaturePortal pages to the reported total with the page's own session cookie", async (t) => {
  const calls: Call[] = [];
  stubFetch(t, recordingFetch(calls, [
    sessionResponse,
    () => jsonResponse(listBody([result(1, "A", "Bengaluru", "India"), result(2, "B", "Milpitas", "United States of America")], "3")),
    () => jsonResponse(listBody([result(3, "C", "Yokkaichi", "Japan")], "3", 2)),
  ]));
  const postings = await listAvaturePortal(company, SEARCH_URL, { interPageDelayMs: 0 });
  assert.deepEqual(postings.map((p) => p.externalId), ["1", "2", "3"]);
  assert.equal(calls.length, 3);
  assert.equal(at(calls, 0).url, SEARCH_URL);
  for (const c of calls.slice(1)) {
    assert.equal(c.cookie, "ScustomPortal-13=sess123");
    assert.match(c.url, /^https:\/\/avature\.sandisk\.com\/13\/_portalList\?/);
  }
  assert.equal(new URL(at(calls, 2).url).searchParams.get("offset"), "2");
});

test("listAvaturePortal stops when the engine wraps past the end back to page one", async (t) => {
  const page1 = () => jsonResponse(listBody([result(1, "A", "Pune", "India"), result(2, "B", "Pune", "India")], null));
  const calls: Call[] = [];
  stubFetch(t, recordingFetch(calls, [sessionResponse, page1, page1]));
  const postings = await listAvaturePortal(company, SEARCH_URL, { interPageDelayMs: 0 });
  assert.deepEqual(postings.map((p) => p.externalId), ["1", "2"]);
  assert.equal(calls.length, 3);
});

test("listAvaturePortal fails the board when the list answers 'private'", async (t) => {
  stubFetch(t, recordingFetch([], [
    sessionResponse,
    () => jsonResponse("This list is private. Please contact your Avature representative.", 403),
  ]));
  await assert.rejects(() => listAvaturePortal(company, SEARCH_URL, { interPageDelayMs: 0 }), /avature HTTP 403/);
});

test("listAvaturePortal fails when the session page has no JobList widget", async (t) => {
  stubFetch(t, recordingFetch([], [() => htmlResponse(CLASSIC_HTML)]));
  await assert.rejects(() => listAvaturePortal(company, SEARCH_URL, { interPageDelayMs: 0 }), /no JobList widget/);
});

test("avatureAdapter.listPostings switches to the portal list API when page one is a JobList widget", async (t) => {
  const calls: Call[] = [];
  stubFetch(t, recordingFetch(calls, [
    () => htmlResponse(PORTAL_HTML),
    sessionResponse,
    () => jsonResponse(listBody([result(1, "A", "Bengaluru", "India")], "1")),
  ]));
  const postings = await avatureAdapter.listPostings(company);
  assert.equal(postings.length, 1);
  assert.equal(at(postings, 0).location, "Bengaluru, India");
  assert.equal(calls.length, 3);
});
