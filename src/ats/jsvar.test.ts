// src/ats/jsvar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseLiteral, jsVarPostings } from "./jsvar.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

test("parseLiteral evals a JS literal (single quotes, bare keys) in a sandbox", () => {
  const v = z.array(z.record(z.string())).parse(parseLiteral("[{ title: 'A', loc: 'Mumbai' }]", false));
  assert.equal(at(v, 0).title, "A");
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
