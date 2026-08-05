// src/ats/nextdata.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dig, parseNextDataIsland, nextDataPostings } from "../nextdata.js";
import type { AdapterCompany } from "../../types.js";
import type { JsonValue } from "../../util/json.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "nextdata",
  slug: "redcliffe-lifetech",
  name: "Redcliffe Lifetech",
  careersUrl: "https://redcliffelabs.com/career",
  tenantUrl: null,
  apiMeta: {
    jobsPath: "props.pageProps.data.getJobList.results",
    titleField: "headline",
    idField: "id",
    locationField: "location",
    jdFields: "job_description,job_responsibility",
  },
};

const ISLAND: JsonValue = {
  props: {
    pageProps: {
      data: {
        getJobList: {
          count: 2,
          results: [
            {
              id: 101,
              headline: "Data Scientist",
              location: "Gurugram",
              job_description: "Build models.",
              job_responsibility: "Ship them.",
            },
            { id: 102, headline: "Phlebotomist", location: "Pune", job_description: "" },
            { id: 103, headline: "", location: "X" },
          ],
        },
      },
    },
  },
};

const HTML = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(ISLAND)}</script></body></html>`;

test("dig walks a tokenized path and returns null on missing hops", () => {
  assert.equal(dig({ a: { b: 3 } }, ["a", "b"]), 3);
  assert.equal(dig({ a: {} }, ["a", "b", "c"]), null);
});

test("dig resolves a numeric hop as an array index", () => {
  assert.equal(dig({ items: ["x", "y"] }, ["items", "1"]), "y");
  assert.equal(dig({ items: ["x"] }, ["items", "5"]), null);
});

test("parseNextDataIsland extracts and parses the script tag", () => {
  const island = parseNextDataIsland(HTML);
  assert.equal(dig(island, ["props", "pageProps", "data", "getJobList", "count"]), 2);
});

test("parseNextDataIsland throws on pages without the island", () => {
  assert.throws(() => parseNextDataIsland("<html></html>"), /__NEXT_DATA__/);
});

test("nextDataPostings maps configured fields and skips titleless rows", () => {
  const postings = nextDataPostings(company, ISLAND);
  assert.equal(postings.length, 2);
  const p = at(postings, 0);
  assert.equal(p.externalId, "101");
  assert.equal(p.jobTitle, "Data Scientist");
  assert.equal(p.location, "Gurugram");
  assert.match(p.jdText, /Build models/);
  assert.match(p.jdText, /Ship them/);
  assert.equal(p.jobUrl, "https://redcliffelabs.com/career");
});

test("nextDataPostings throws when jobsPath misses", () => {
  const { apiMeta } = company;
  assert(apiMeta);
  assert.throws(
    () => nextDataPostings({ ...company, apiMeta: { ...apiMeta, jobsPath: "props.nope" } }, ISLAND),
    /did not resolve to an array/,
  );
});
