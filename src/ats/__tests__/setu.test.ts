import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvRows, parseSetuCsv, setuExternalId, normalizeSetuRow, extractSetuJdText, SETU_LOCATION } from "../setu.js";
import type { SetuRow } from "../setu.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "setu",
  slug: "setu",
  name: "Setu",
  careersUrl: "https://setu.co/careers",
  tenantUrl: null,
  apiMeta: null,
};

test("parseCsvRows splits plain comma-separated rows", () => {
  const rows = parseCsvRows("a,b,c\n1,2,3\n");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parseCsvRows handles quoted fields containing commas", () => {
  const rows = parseCsvRows('Role,Link\n"Senior Manager, Enterprise Sales",https://example.com/x\n');
  assert.deepEqual(rows, [
    ["Role", "Link"],
    ["Senior Manager, Enterprise Sales", "https://example.com/x"],
  ]);
});

test("parseCsvRows handles doubled-quote escaping inside a quoted field", () => {
  const rows = parseCsvRows('Role\n"Say ""hi"" please"\n');
  assert.deepEqual(rows, [["Role"], ['Say "hi" please']]);
});

test("parseCsvRows handles CRLF line endings", () => {
  const rows = parseCsvRows("a,b\r\n1,2\r\n3,4\r\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("parseCsvRows skips fully-blank lines", () => {
  const rows = parseCsvRows("a,b\n1,2\n\n3,4\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("parseCsvRows handles a file with no trailing newline", () => {
  const rows = parseCsvRows("a,b\n1,2");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

// Trimmed excerpt of the real CSV, plus one synthetic row with an empty Description/Sub-category (a verified live shape).
const REAL_CSV = `Role,Description,Link,Category,Sub-category
SDE -II,https://docs.google.com/document/d/1wqbbzRAOxwIY8IjhLlAiVeoKHVFNFyWEib8gKmcsa38/edit?usp=sharing,https://pinelabsgroup.turbohire.co/get/YXQ5M3d,Engineering,Platform
Senior Manager - Strategic Accounts,,https://pinelabsgroup.turbohire.co/get/OGk2WWZ,Sales,
Data Engineer ,https://drive.google.com/file/d/1I4Iwf8ZoQmi0qBLTYbrhDfWeuYg-BAdu/view?usp=drive_link,https://pinelabsgroup.turbohire.co/get/aDFnNUx,Engineering,Data
`;

test("parseSetuCsv maps columns by header name and trims cells", () => {
  const rows = parseSetuCsv(REAL_CSV);
  assert.equal(rows.length, 3);
  assert.equal(at(rows, 0).role, "SDE -II");
  assert.equal(at(rows, 0).link, "https://pinelabsgroup.turbohire.co/get/YXQ5M3d");
  assert.equal(at(rows, 0).category, "Engineering");
  assert.equal(at(rows, 1).role, "Senior Manager - Strategic Accounts");
  assert.equal(at(rows, 1).description, "");
  assert.equal(at(rows, 1).subCategory, "");
  assert.equal(at(rows, 2).role, "Data Engineer");
});

test("parseSetuCsv throws on an unrecognized header", () => {
  assert.throws(() => parseSetuCsv("Foo,Bar\n1,2\n"), /missing expected column/);
});

test("parseSetuCsv throws on empty input", () => {
  assert.throws(() => parseSetuCsv(""), /empty CSV/);
});

test("setuExternalId extracts the TurboHire code from the Link URL", () => {
  const row: SetuRow = {
    role: "SDE -II",
    description: "",
    link: "https://pinelabsgroup.turbohire.co/get/YXQ5M3d",
    category: "Engineering",
    subCategory: "Platform",
  };
  assert.equal(setuExternalId(row), "YXQ5M3d");
});

test("setuExternalId falls back to a slugified role when the Link doesn't match", () => {
  const row: SetuRow = {
    role: "Senior Manager - Strategic Accounts",
    description: "",
    link: "https://example.com/careers/apply",
    category: "Sales",
    subCategory: "",
  };
  assert.equal(setuExternalId(row), "senior-manager-strategic-accounts");
});

test("normalizeSetuRow builds a posting with the fixed HQ location", () => {
  const rows = parseSetuCsv(REAL_CSV);
  const p = normalizeSetuRow(company, at(rows, 0));
  assert.equal(p.provider, "setu");
  assert.equal(p.externalId, "YXQ5M3d");
  assert.equal(p.jobTitle, "SDE -II");
  assert.equal(p.jobUrl, "https://pinelabsgroup.turbohire.co/get/YXQ5M3d");
  assert.equal(p.location, SETU_LOCATION);
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
});

// Trimmed live-captured shape: head + the schema.org JobPosting script carrying the full plain-text JD.
const REAL_JOB_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>TurboHire</title>
<meta property="og:title" content="[Hiring For]: SDE II(DT_210)"/>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"SDE II(DT_210)","datePosted":"2025-11-04","description":"SDE II — PlatformAbout Setu India’s economic infrastructure needs a complete overhaul. Importance of the role This is a mission-critical role.","hiringOrganization":{"@type":"Organization","name":"Pine Labs Group","sameAs":"https://www.pinelabs.com/"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Bangalore, Karnataka, India","addressCountry":"India"}}}</script>
</head><body><div id="root"></div></body></html>`;

test("extractSetuJdText pulls the JSON-LD JobPosting description", () => {
  const jd = extractSetuJdText(REAL_JOB_PAGE_HTML);
  assert.match(jd, /About Setu/);
  assert.match(jd, /Importance of the role/);
});

test("extractSetuJdText falls back to whole-page strip when the island is absent", () => {
  const html = "<html><body><main>About Setu — no JSON-LD here, just plain HTML.</main></body></html>";
  const jd = extractSetuJdText(html);
  assert.match(jd, /About Setu/);
});

test("extractSetuJdText falls back to whole-page strip when the island is malformed JSON", () => {
  const html = `<script type="application/ld+json">{not valid json</script><body>About Setu fallback text</body>`;
  const jd = extractSetuJdText(html);
  assert.match(jd, /About Setu fallback text/);
});
