// src/ats/eightfoldpcs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eightfoldPcsSearchUrl,
  eightfoldPcsDetailsUrl,
  eightfoldPcsPageJobs,
  normalizeEightfoldPcs,
} from "../eightfoldpcs.js";
import type { EightfoldPcsPosition } from "../eightfoldpcs.js";
import type { AdapterCompany } from "../../types.js";
import { htmlToText } from "../htmlText.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "eightfoldpcs", slug: "qualcomm", name: "Qualcomm",
  careersUrl: "https://careers.qualcomm.com/careers",
  tenantUrl: "https://careers.qualcomm.com",
  apiMeta: { domain: "qualcomm.com", location: "India" },
};

const position: EightfoldPcsPosition = {
  id: 446718579822,
  name: "IP Validation Engineer (Security) - Senior/Lead",
  locations: ["Bangalore, Karnataka, India"],
  standardizedLocations: ["Bengaluru, KA, IN"],
  postedTs: 1779148800,
  creationTs: 1779148800,
  workLocationOption: "onsite",
  positionUrl: "/careers/job/446718579822",
};

const position2: EightfoldPcsPosition = {
  id: 446719370031,
  name: "CPU Design Verification Sr Engineer (Remote)",
  locations: ["Remote, United States"],
  standardizedLocations: null,
  postedTs: null,
  creationTs: 1782259200,
  workLocationOption: "remote",
  positionUrl: "/careers/job/446719370031",
};

// Real (trimmed) `data.positions` shape from careers.qualcomm.com/api/pcsx/search.
const searchFixture = {
  status: 200,
  error: { message: "", body: "" },
  data: {
    positions: [position, position2],
    count: 461,
  },
};

const detailsFixture = {
  status: 200,
  error: { message: "", body: "" },
  data: {
    id: 446718579822,
    name: "IP Validation Engineer (Security) - Senior/Lead",
    jobDescription: "<h2><b>Company:</b></h2>Qualcomm India Private Limited<p>Role Overview</p><ul><li>Debug hardware issues</li></ul>",
    location: "Bangalore, Karnataka, India",
    publicUrl: "https://careers.qualcomm.com/careers/job/446718579822",
    workLocationOption: "onsite",
  },
};

test("eightfoldPcsSearchUrl builds the paged search URL with domain + apiMeta.location", () => {
  assert.equal(
    eightfoldPcsSearchUrl(company, 10),
    "https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com&query=&location=India&start=10&num=10&sort_by=relevance&triggerGoButton=false",
  );
});

test("eightfoldPcsSearchUrl omits the location filter without apiMeta.location", () => {
  const c: AdapterCompany = { ...company, apiMeta: { domain: "qualcomm.com" } };
  assert.equal(
    eightfoldPcsSearchUrl(c, 0),
    "https://careers.qualcomm.com/api/pcsx/search?domain=qualcomm.com&query=&location=&start=0&num=10&sort_by=relevance&triggerGoButton=false",
  );
});

test("eightfoldPcsSearchUrl throws without tenant_url or apiMeta.domain", () => {
  assert.throws(() => eightfoldPcsSearchUrl({ ...company, tenantUrl: null }, 0));
  assert.throws(() => eightfoldPcsSearchUrl({ ...company, apiMeta: null }, 0));
});

test("eightfoldPcsDetailsUrl builds the position_details URL", () => {
  assert.equal(
    eightfoldPcsDetailsUrl(company, "446718579822"),
    "https://careers.qualcomm.com/api/pcsx/position_details?position_id=446718579822&domain=qualcomm.com&hl=en",
  );
});

test("eightfoldPcsPageJobs unwraps the data.{positions,count} envelope", () => {
  const { positions, count } = eightfoldPcsPageJobs(asJson(searchFixture));
  assert.equal(count, 461);
  assert.equal(positions.length, 2);
  assert.equal(positions[0]?.name, "IP Validation Engineer (Security) - Senior/Lead");
});

test("eightfoldPcsPageJobs tolerates a missing count", () => {
  const { count } = eightfoldPcsPageJobs({ data: { positions: [] } });
  assert.equal(count, null);
});

test("normalizeEightfoldPcs maps list metadata: id, url from positionUrl, location precedence, ISO date, empty JD", () => {
  const p = normalizeEightfoldPcs(company, position);
  assert.equal(p.provider, "eightfoldpcs");
  assert.equal(p.externalId, "446718579822");
  assert.equal(p.jobTitle, "IP Validation Engineer (Security) - Senior/Lead");
  assert.equal(p.jobUrl, "https://careers.qualcomm.com/careers/job/446718579822");
  assert.equal(p.location, "Bangalore, Karnataka, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, ""); // absent from list; populated by fetchJd
  assert.equal(p.postedAt, new Date(1779148800 * 1000).toISOString());
});

test("normalizeEightfoldPcs: remote workLocationOption sets isRemote, falls back to standardizedLocations, falls back to creationTs", () => {
  const p = normalizeEightfoldPcs(company, position2);
  assert.equal(p.location, "Remote, United States");
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, new Date(1782259200 * 1000).toISOString());
});

test("normalizeEightfoldPcs synthesizes the job URL from id when positionUrl is absent", () => {
  const p = normalizeEightfoldPcs(company, { ...position, positionUrl: null });
  assert.equal(p.jobUrl, "https://careers.qualcomm.com/careers/job/446718579822");
});

// fetchJd itself just does atsFetchJson + DetailSchema.safeParse + this same
// extraction; exercise the extraction directly against the real fixture
// shape rather than mocking the network call.
test("position_details jobDescription extraction is html-stripped (mirrors fetchJd)", () => {
  const jd = htmlToText(detailsFixture.data.jobDescription);
  assert.match(jd, /Role Overview/);
  assert.match(jd, /Debug hardware issues/);
  assert.doesNotMatch(jd, /<p>|<li>|<b>/);
});
