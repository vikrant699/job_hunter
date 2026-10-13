import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseLiteral, jsVarPostings, jsVarConfig, discoverAssetUrl, jsvarAdapter } from "../jsvar.js";
import type { AdapterCompany } from "../../types.js";
import { at, fetchSequence, htmlResponse, stubFetch } from "./testHelpers.js";

test("parseLiteral evals a JS literal (single quotes, bare keys) in a sandbox", () => {
  const v = z.array(z.record(z.string())).parse(parseLiteral("[{ title: 'A', loc: 'Mumbai' }]", false));
  assert.equal(at(v, 0).title, "A");
});

test("parseLiteral cannot reach host globals (sandboxed)", () => {
  assert.throws(() => parseLiteral("[process.pid]", false));
});

// parseLiteral normalises through JSON rather than validating the raw eval result, since JS literals can hold values JsonValue can't represent.
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

// slugField resolves {slug} in urlTemplate via a configurable dot-path (ofbcareers.com uses "link-jobs-jobTitle", not "slug").
test("jsVarPostings resolves {slug} from apiMeta.slugField when set", () => {
  const company: AdapterCompany = {
    ...arrayCompany,
    slug: "ofbusiness",
    apiMeta: {
      startMarker: '"recordsByCollectionId":{"Jobs":',
      open: "{",
      container: "object",
      titleField: "jobTitle",
      locationField: "location",
      jdFields: "jobDescription,whatYouWillDo",
      slugField: "link-jobs-jobTitle",
      urlTemplate: "https://www.ofbcareers.com{slug}",
    },
  };
  const html = `..."recordsByCollectionId":{"Jobs":{
    "uuid-1": { "jobTitle": "Quality Executive", "location": "Indore",
      "jobDescription": "<p>Inspect pulses.</p>", "whatYouWillDo": "<p>Grade grains.</p>",
      "link-jobs-jobTitle": "/jobs/quality-executive" },
    "uuid-2": { "_id": "stub-without-title" }
  }}...`;
  const p = jsVarPostings(company, html);
  assert.equal(p.length, 1);
  const p0 = at(p, 0);
  assert.equal(p0.externalId, "uuid-1");
  assert.equal(p0.jobUrl, "https://www.ofbcareers.com/jobs/quality-executive");
  assert.match(p0.jdText, /Inspect pulses\./);
  assert.match(p0.jdText, /Grade grains\./);
});

const bundleCompany: AdapterCompany = {
  ...arrayCompany,
  slug: "algouniversity",
  careersUrl: "https://www.algouniversity.com/careers",
  apiMeta: {
    assetPattern: "assets/index-[^/]+\\.js$",
    startPattern: '\\[\\{id:"[^"]+",title:"',
    open: "[",
    titleField: "title",
    idField: "id",
    locationField: "location",
    jdFields: "blurb,responsibilities",
  },
};

const bundleJs = (varName: string) =>
  `const ql=["Growth","Sales"],${varName}=[{id:"growth-associate",title:"Growth Associate",location:"Hyderabad",` +
  `blurb:"Own growth.",responsibilities:["Run campaigns","Track CAC"]},` +
  `{id:"sde",title:"SDE",location:"Bangalore",blurb:"Ship code.",responsibilities:[]}];`;

test("jsVarPostings startPattern finds the array whatever the minified variable is named", () => {
  for (const name of ["cn", "Xe"]) {
    const p = jsVarPostings(bundleCompany, bundleJs(name));
    assert.equal(p.length, 2);
    assert.equal(at(p, 0).externalId, "growth-associate");
    assert.match(at(p, 0).jdText, /Track CAC/);
    assert.equal(at(p, 1).location, "Bangalore");
  }
});

test("jsVarPostings throws when startPattern matches nothing", () => {
  assert.throws(() => jsVarPostings(bundleCompany, "const x=[1,2];"), /startPattern/);
});

test("jsVarConfig requires startMarker or startPattern", () => {
  const company: AdapterCompany = { ...arrayCompany, apiMeta: { titleField: "title" } };
  assert.throws(() => jsVarConfig(company), /startMarker or apiMeta.startPattern/);
});

test("discoverAssetUrl resolves the first matching <script src> against the page URL", () => {
  const html = `<script src="https://cdn.example.com/vendor.js"></script>
    <script type="module" crossorigin src="/careers/assets/index-DI2Oc7wJ.js"></script>
    <script src='/careers/assets/index-Zz9.js'></script>`;
  assert.equal(
    discoverAssetUrl(html, "https://www.algouniversity.com/careers", /assets\/index-[^/]+\.js$/),
    "https://www.algouniversity.com/careers/assets/index-DI2Oc7wJ.js",
  );
  assert.equal(discoverAssetUrl(html, "https://x.com/", /nope/), null);
});

test("jsvarAdapter discovers the current bundle from the careers page when assetPattern is set", async (t) => {
  const urls: string[] = [];
  const responses = [
    () => htmlResponse(`<html><script type="module" src="/careers/assets/index-NEWHASH.js"></script></html>`),
    () => htmlResponse(bundleJs("q")),
  ];
  stubFetch(t, (input) => {
    urls.push(String(input));
    return Promise.resolve(at(responses, urls.length - 1)());
  });
  const p = await jsvarAdapter.listPostings(bundleCompany);
  assert.equal(p.length, 2);
  assert.deepEqual(urls, [
    "https://www.algouniversity.com/careers",
    "https://www.algouniversity.com/careers/assets/index-NEWHASH.js",
  ]);
});

test("jsvarAdapter fails clearly when no <script src> matches assetPattern", async (t) => {
  stubFetch(t, fetchSequence(() => htmlResponse(`<html><script src="/other.js"></script></html>`)));
  await assert.rejects(jsvarAdapter.listPostings(bundleCompany), /assetPattern/);
});

test("jsvarAdapter still fetches a fixed assetUrl directly", async (t) => {
  const urls: string[] = [];
  stubFetch(t, (input) => {
    urls.push(String(input));
    return Promise.resolve(htmlResponse(bundleJs("cn")));
  });
  const company: AdapterCompany = {
    ...bundleCompany,
    apiMeta: {
      assetUrl: "https://www.algouniversity.com/careers/assets/index-OLD.js",
      startPattern: '\\[\\{id:"[^"]+",title:"',
      titleField: "title",
      idField: "id",
    },
  };
  const p = await jsvarAdapter.listPostings(company);
  assert.equal(p.length, 2);
  assert.deepEqual(urls, ["https://www.algouniversity.com/careers/assets/index-OLD.js"]);
});
