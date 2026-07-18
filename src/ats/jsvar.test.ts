// src/ats/jsvar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBalanced, parseLiteral, jsVarPostings } from "./jsvar.js";
import type { AdapterCompany } from "../types.js";

test("extractBalanced pulls a bracket-balanced array, ignoring brackets in strings", () => {
  const src = `foo const ROLES = [{ title: 'A]B', note: "x[y" }, { title: 'C' }]; bar`;
  const lit = extractBalanced(src, "const ROLES =", "[");
  assert.ok(lit);
  assert.equal(lit!.startsWith("[{"), true);
  assert.equal(lit!.endsWith("}]"), true);
});

test("extractBalanced handles object container + backtick strings", () => {
  const src = "x jobData = { a: { t: `has } brace` }, b: { t: 'y' } } ;";
  const lit = extractBalanced(src, "jobData =", "{");
  assert.ok(lit);
  const val = parseLiteral(lit!, false) as Record<string, unknown>;
  assert.deepEqual(Object.keys(val), ["a", "b"]);
});

test("extractBalanced returns null when the marker is absent", () => {
  assert.equal(extractBalanced("nothing here", "const X =", "["), null);
});

test("parseLiteral evals a JS literal (single quotes, bare keys) in a sandbox", () => {
  const v = parseLiteral("[{ title: 'A', loc: 'Mumbai' }]", false) as Array<Record<string, string>>;
  assert.equal(v[0]!.title, "A");
});

test("parseLiteral cannot reach host globals (sandboxed)", () => {
  assert.throws(() => parseLiteral("[process.pid]", false));
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
  assert.equal(p[0]!.jobTitle, "Ops Lead");
  assert.equal(p[0]!.location, "Gurugram");
  assert.match(p[0]!.jdText, /Run ops/);
  assert.equal(p[1]!.isRemote, true);
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
  assert.equal(p[0]!.externalId, "REQ-001");
  assert.equal(p[0]!.jobTitle, "CBO");
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
  assert.equal(p[0]!.jobTitle, "Vehicle Architecture");
  assert.equal(p[0]!.location, "Manesar");
  assert.equal(p[0]!.externalId, "1");
});
