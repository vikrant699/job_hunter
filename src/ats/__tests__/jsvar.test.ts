// src/ats/jsvar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseLiteral, jsVarPostings } from "../jsvar.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

test("parseLiteral evals a JS literal (single quotes, bare keys) in a sandbox", () => {
  const v = z.array(z.record(z.string())).parse(parseLiteral("[{ title: 'A', loc: 'Mumbai' }]", false));
  assert.equal(at(v, 0).title, "A");
});

test("parseLiteral cannot reach host globals (sandboxed)", () => {
  assert.throws(() => parseLiteral("[process.pid]", false));
});

// A scraped JS literal is JavaScript, not JSON, so it can hold values JsonValue
// cannot represent. parseLiteral normalises through JSON rather than validating
// the raw eval result — validating it directly threw on all four of these, which
// would have broken the jsvar boards that ship them.
test("parseLiteral tolerates JS-only values that JSON cannot represent", () => {
  const undef = z.array(z.object({ title: z.string(), deadline: z.string().optional() }))
    .parse(parseLiteral("[{ title: 'A', deadline: undefined }]", false));
  assert.equal(at(undef, 0).deadline, undefined, "an undefined value drops out, leaving the key absent");

  const holes = z.object({ tags: z.array(z.string().nullable()) })
    .parse(parseLiteral("({ tags: ['a', , 'c'] })", false));
  assert.deepEqual(holes.tags, ["a", null, "c"], "an array hole becomes null, not a throw");

  const nan = z.object({ n: z.number().nullable() }).parse(parseLiteral("({ n: NaN })", false));
  assert.equal(nan.n, null, "NaN becomes null");

  const dated = z.object({ posted: z.string() }).parse(parseLiteral("({ posted: new Date(0) })", false));
  assert.equal(dated.posted, "1970-01-01T00:00:00.000Z", "a Date becomes its ISO string");

  const fn = z.object({ title: z.string() }).parse(parseLiteral("({ title: 'A', fn: function () {} })", false));
  assert.equal(fn.title, "A", "a function is dropped rather than failing the whole literal");
});

const arrayCompany: AdapterCompany = {
  provider: "jsvar",
  slug: "easemytrip",
  name: "EaseMyTrip",
  careersUrl: "https://www.easemytrip.com/career.html",
  tenantUrl: null,
  apiMeta: {
    startMarker: "const ROLES =",
    open: "[",
    titleField: "title",
    locationField: "loc",
    jdFields: "about",
    fixedLocation: "India",
  },
};

test("jsVarPostings maps an array literal", () => {
  const html = `<script>const ROLES = [
    { title: 'Ops Lead', loc: 'Gurugram', about: 'Run ops.' },
    { title: 'Remote SRE', loc: 'Remote', about: 'Keep it up.' },
    { title: '', loc: 'X' }
  ];</script>`;
  const p = jsVarPostings(arrayCompany, html);
  assert.equal(p.length, 2);
  const p0 = at(p, 0);
  assert.equal(p0.jobTitle, "Ops Lead");
  assert.equal(p0.location, "Gurugram");
  assert.match(p0.jdText, /Run ops/);
  assert.equal(at(p, 1).isRemote, true);
});

test("jsVarPostings maps an object-container literal using keys as ids", () => {
  const company: AdapterCompany = {
    ...arrayCompany,
    slug: "wazirx",
    apiMeta: {
      startMarker: "const JOB_DATA =",
      open: "{",
      container: "object",
      titleField: "title",
      locationField: "location",
      jdFields: "overview",
    },
  };
  const js = `const JOB_DATA = {
    'REQ-001': { title: 'CBO', location: 'Mumbai', overview: 'Own P&L.' },
    'REQ-002': { title: 'SRE', location: 'Remote', overview: 'Ops.' }
  };`;
  const p = jsVarPostings(company, js);
  assert.equal(p.length, 2);
  const p0 = at(p, 0);
  assert.equal(p0.externalId, "REQ-001");
  assert.equal(p0.jobTitle, "CBO");
});

test("jsVarPostings unescapes and JSON-parses a flight-style blob", () => {
  const company: AdapterCompany = {
    ...arrayCompany,
    slug: "revolt-motors",
    apiMeta: {
      startMarker: '"initialJobs":',
      open: "[",
      unescape: "true",
      titleField: "designation",
      idField: "id",
      locationField: "location",
      jdFields: "short_text",
    },
  };
  const html = `self.__next_f.push([1,"...\\"initialJobs\\":[{\\"id\\":1,\\"designation\\":\\"Vehicle Architecture\\",\\"location\\":\\"Manesar\\",\\"short_text\\":\\"Build EVs.\\"}]..."])`;
  const p = jsVarPostings(company, html);
  assert.equal(p.length, 1);
  const p0 = at(p, 0);
  assert.equal(p0.jobTitle, "Vehicle Architecture");
  assert.equal(p0.location, "Manesar");
  assert.equal(p0.externalId, "1");
});
