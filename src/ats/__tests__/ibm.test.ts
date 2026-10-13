import { test } from "node:test";
import assert from "node:assert/strict";
import { ibmAdapter, ibmListBody, ibmDetailBody, ibmLocation, IBM_PAGE_SIZE } from "../ibm.js";
import { stubFetch, jsonResponse, mkAdapterCompany, at } from "./testHelpers.js";
import { JsonValueSchema } from "../../util/json.js";
import type { JsonValue } from "../../util/json.js";
import type { NormalizedPosting } from "../../types.js";

const company = mkAdapterCompany(
  { provider: "ibm", slug: "confluent", name: "Confluent", careersUrl: "https://www.ibm.com/careers/search?q=confluent" },
  { apiMeta: { query: "confluent", country: "India" } },
);

interface Src {
  title: string;
  url: string;
  field_text_01: number;
  field_keyword_05: string;
  field_keyword_19: string;
  field_keyword_17: string;
}

function hit(jobId: number, over: Partial<Src> = {}): { _id: string; _source: Src } {
  return {
    _id: `doc${jobId}`,
    _source: {
      title: `Engineer ${jobId}`,
      url: `https://careers.ibm.com/careers/JobDetail?jobId=${jobId}`,
      field_text_01: jobId,
      field_keyword_05: "India",
      field_keyword_19: "Bangalore, IN",
      field_keyword_17: "Hybrid",
      ...over,
    },
  };
}

function searchResponse(hits: Array<{ _id: string; _source: Partial<Src> & { body?: string } }>, total: number): Response {
  return jsonResponse({ took: 3, hits: { total: { value: total, relation: "eq" }, hits } });
}

function bodyOf(init: RequestInit | undefined): JsonValue {
  return JsonValueSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
}

test("ibmListBody scopes by query + country, sorts on _id for stable paging", () => {
  assert.deepEqual(ibmListBody({ query: "confluent", country: "India" }, 200), {
    appId: "careers",
    scopes: ["careers2"],
    query: {
      bool: {
        must: [{ simple_query_string: { query: "confluent", fields: ["keywords^1", "body^1", "url^2", "description^2", "h1s_content^2", "title^3", "field_text_01"] } }],
        filter: [{ term: { field_keyword_05: "India" } }],
      },
    },
    size: IBM_PAGE_SIZE,
    from: 200,
    sort: [{ _id: "asc" }],
    lang: "zz",
    _source: ["title", "url", "field_text_01", "field_keyword_05", "field_keyword_17", "field_keyword_19"],
  });
});

test("ibmListBody with neither query nor country lists the whole index (the API 400s an empty filter array)", () => {
  const body = ibmListBody({ query: null, country: null }, 0);
  assert.deepEqual(body.query, { bool: { must: [] } });
});

test("ibmDetailBody fetches one job's body by numeric job id", () => {
  assert.deepEqual(ibmDetailBody(131931), {
    appId: "careers",
    scopes: ["careers2"],
    query: { bool: { must: [], filter: [{ term: { field_text_01: 131931 } }] } },
    size: 1,
    lang: "zz",
    _source: ["body"],
  });
});

test("ibmLocation swaps the trailing ISO code for the country name and drops placeholders", () => {
  assert.equal(ibmLocation("Bangalore, IN", "India"), "Bangalore, India");
  assert.equal(ibmLocation("GURGAON, IN", "India"), "GURGAON, India");
  assert.equal(ibmLocation("No City, US", "United States"), "United States");
  assert.equal(ibmLocation("Multiple Cities", "Canada"), "Multiple Cities, Canada");
  assert.equal(ibmLocation("", ""), null);
});

test("listPostings pages by from until a short page, normalizing every hit", async (t) => {
  const bodies: JsonValue[] = [];
  const page1 = Array.from({ length: IBM_PAGE_SIZE }, (_, i) => hit(1000 + i));
  const page2 = [hit(2000, { field_keyword_17: "Remote", field_keyword_19: "Multiple Cities", title: "Remote Role" })];
  stubFetch(t, (input, init) => {
    assert.equal(String(input), "https://www-api.ibm.com/search/api/v2");
    assert.equal(init?.method, "POST");
    bodies.push(bodyOf(init));
    return Promise.resolve(bodies.length === 1 ? searchResponse(page1, 101) : searchResponse(page2, 101));
  });

  const postings = await ibmAdapter.listPostings(company);

  assert.equal(postings.length, IBM_PAGE_SIZE + 1);
  assert.deepEqual(bodies.map((b) => (b !== null && typeof b === "object" && !Array.isArray(b) ? b.from : null)), [0, IBM_PAGE_SIZE]);
  assert.deepEqual(at(postings, 0), {
    provider: "ibm",
    externalId: "1000",
    companySlug: "confluent",
    companyName: "Confluent",
    jobTitle: "Engineer 1000",
    jobUrl: "https://careers.ibm.com/careers/JobDetail?jobId=1000",
    location: "Bangalore, India",
    isRemote: false,
    jdText: "",
    postedAt: null,
  });
  const last = at(postings, IBM_PAGE_SIZE);
  assert.equal(last.isRemote, true);
  assert.equal(last.location, "Multiple Cities, India");
});

test("listPostings stops at the reported total without an extra empty fetch", async (t) => {
  let calls = 0;
  stubFetch(t, () => {
    calls++;
    return Promise.resolve(searchResponse([hit(1), hit(2)], 2));
  });
  const postings = await ibmAdapter.listPostings(mkAdapterCompany({ provider: "ibm", slug: "ibm", name: "IBM", careersUrl: "https://www.ibm.com/careers/search" }));
  assert.equal(postings.length, 2);
  assert.equal(calls, 1);
});

test("listPostings throws a schema error on an unexpected payload", async (t) => {
  stubFetch(t, () => Promise.resolve(jsonResponse({ errors: [{ msg: "Parameter 'size' has an invalid value" }] })));
  await assert.rejects(ibmAdapter.listPostings(company), /schema/);
});

function posting(jobId: number): NormalizedPosting {
  return {
    provider: "ibm", externalId: String(jobId), companySlug: "confluent", companyName: "Confluent", jobTitle: "x",
    jobUrl: `https://careers.ibm.com/careers/JobDetail?jobId=${jobId}`, location: null, isRemote: false, jdText: "", postedAt: null,
  };
}

test("fetchJd pulls the job body from the search API by job id", async (t) => {
  let sent: JsonValue = null;
  stubFetch(t, (_input, init) => {
    sent = bodyOf(init);
    return Promise.resolve(searchResponse([{ _id: "doc131931", _source: { body: "  Build Kafka services.  India Software Engineering  " } }], 1));
  });
  const jd = await ibmAdapter.fetchJd?.(company, posting(131931));
  assert.equal(jd, "Build Kafka services. India Software Engineering");
  assert.deepEqual(sent, ibmDetailBody(131931));
});

test("fetchJd returns empty when the job has vanished from the index", async (t) => {
  stubFetch(t, () => Promise.resolve(searchResponse([], 0)));
  assert.equal(await ibmAdapter.fetchJd?.(company, posting(5)), "");
});
