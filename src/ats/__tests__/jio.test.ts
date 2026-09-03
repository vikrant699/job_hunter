import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJioFunctions, parseJioRows, parseJioJd, jioNextIsClickable } from "../jio.js";
import type { AdapterCompany } from "../../types.js";
import { at } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "jio",
  slug: "reliance-jio",
  name: "Reliance Jio",
  careersUrl: "https://careers.jio.com/frmJobCategories.aspx",
  tenantUrl: null,
  apiMeta: null,
};

test("parseJioFunctions extracts the job-function links, absolutized, with names", () => {
  const html = `<html><body>
    <a href="frmfuncwisejob.aspx?func=AAA=&amp;desc=BBB=&amp;flag=/wASbQn4xyQ=">Engineering &amp; Technology <span>252</span></a>
    <a href="frmfuncwisejob.aspx?func=CCC=&amp;desc=DDD=&amp;flag=/wASbQn4xyQ=">Sales and Distribution</a>
    <a href="/index.aspx">Home</a>
  </body></html>`;
  const fns = parseJioFunctions(html);
  assert.equal(fns.length, 2);
  assert.equal(at(fns, 0).name, "Engineering & Technology");
  assert.match(at(fns, 0).url, /^https:\/\/careers\.jio\.com\/frmfuncwisejob\.aspx\?func=AAA=&desc=BBB=&flag=/);
});

// Job rows: an <a id="…hylUser_N"> with text "Title ( jobcode )", plus a sibling <span id="…Label2_N"> location.
const ROWS_HTML = `<html><body><table>
  <tr>
    <td><a id="MainContent_lstJoblist_hylUser_0" href="frmjobdescription.aspx?JBTITLE=T1&amp;jbID=J1&amp;funcCode=F1">Frontend Engineer ( 86701445 )</a></td>
    <td><span id="MainContent_lstJoblist_Label2_0"> Mumbai</span></td>
  </tr>
  <tr>
    <td><a id="MainContent_lstJoblist_hylUser_1" href="frmjobdescription.aspx?JBTITLE=T2&amp;jbID=J2&amp;funcCode=F1">Data Analyst</a></td>
    <td><span id="MainContent_lstJoblist_Label2_1"> Bengaluru</span></td>
  </tr>
</table></body></html>`;

test("parseJioRows maps each row: jobcode externalId, clean title, location, absolute JD url", () => {
  const rows = parseJioRows(company, ROWS_HTML);
  assert.equal(rows.length, 2);
  const fe = at(rows, 0);
  assert.equal(fe.provider, "jio");
  assert.equal(fe.externalId, "86701445"); // the numeric jobcode from "( … )"
  assert.equal(fe.jobTitle, "Frontend Engineer");
  assert.equal(fe.location, "Mumbai");
  assert.match(fe.jobUrl, /^https:\/\/careers\.jio\.com\/frmjobdescription\.aspx\?JBTITLE=T1&jbID=J1&funcCode=F1$/);
  assert.equal(fe.jdText, "");
});

test("parseJioRows falls back to the jbID when a title carries no ( jobcode )", () => {
  const rows = parseJioRows(company, ROWS_HTML);
  assert.equal(at(rows, 1).externalId, "J2"); // no "( … )" -> jbID token
  assert.equal(at(rows, 1).jobTitle, "Data Analyst");
});

test("parseJioRows returns [] when there are no job-link rows", () => {
  assert.deepEqual(parseJioRows(company, "<html><body><p>none</p></body></html>"), []);
});

test("parseJioJd concatenates the role/education/experience/skill spans as plain text", () => {
  const html = `<html><body>
    <span id="MainContent_lblSummRole">Build UI with React.</span>
    <span id="MainContent_lblEduReq">B.Tech CS</span>
    <span id="MainContent_lblExpReq">2 - 5 years</span>
    <span id="MainContent_lblSkill"><ul><li>JavaScript</li></ul></span>
  </body></html>`;
  const jd = parseJioJd(html);
  assert.match(jd, /Build UI with React\./);
  assert.match(jd, /B\.Tech CS/);
  assert.match(jd, /2 - 5 years/);
  assert.match(jd, /JavaScript/);
});

test("parseJioJd returns '' when none of the JD spans are present", () => {
  assert.equal(parseJioJd("<html><body><p>nothing</p></body></html>"), "");
});

test("jioNextIsClickable is false when the Next submit is disabled/absent, true when live", () => {
  assert.equal(jioNextIsClickable(`<input type="submit" id="X_lnkNext" value="Next" class="search-orange-but">`), true);
  assert.equal(jioNextIsClickable(`<input type="submit" id="X_lnkNext" value="Next" disabled="disabled" class="aspNetDisabled search-orange-but">`), false);
  assert.equal(jioNextIsClickable(`<div>no pager</div>`), false);
});
