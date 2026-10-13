import { test } from "node:test";
import assert from "node:assert/strict";
import {
  manappuramAdapter,
  manappuramJdFromDetail,
  manappuramPostedAt,
  parseManappuramList,
  MANAPPURAM_LIST_URL,
  MANAPPURAM_JD_URL,
  MANAPPURAM_PORTAL_URL,
} from "../manappuram.js";
import type { AdapterCompany } from "../../types.js";
import { asJson, at, jsonResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company: AdapterCompany = mkAdapterCompany({
  provider: "manappuram",
  slug: "manappuram-finance",
  name: "Manappuram Finance",
  careersUrl: MANAPPURAM_PORTAL_URL,
});

const row = (over: Record<string, string | number | null> = {}) => ({
  MRF_ID: 482.0, DEPT_NAME: "HRM (T)", SUB_DEPT_NAME: "L & D TECHNOLOGY", POSITION_NAME: "DEVELOPER TRAINEE",
  DESIGNATION_NAME: "JR. ASST.", LOCATION: "A.O.VALAPAD", STATE: null, DISTRICT: null, VACANCY: 1.0, EXPR: "Nil",
  APPROVAL_DATE: "2026-10-07T00:00:00", POSTED_ON: 6.0, POSTED_DT: "6 day(s) ago", ...over,
});

// ASP.NET PageMethods wrap the payload as {"d": "<json string>"}
const wrap = <T>(body: T) => ({ d: JSON.stringify(body) });

test("parseManappuramList unwraps the d-string envelope", () => {
  const rows = parseManappuramList(asJson(wrap({ Status: 200, Message: "Success", Data: [row(), row({ MRF_ID: 481.0 })] })));
  assert.equal(rows.length, 2);
  assert.equal(at(rows, 1).MRF_ID, 481);
});

test("parseManappuramList throws on a non-200 Status or a wrong envelope", () => {
  assert.throws(() => parseManappuramList(asJson(wrap({ Status: 500, Message: "Error", Data: [] }))), /Status 500/);
  assert.throws(() => parseManappuramList(asJson({ Data: [] })), /schema/);
});

test("manappuramPostedAt uses APPROVAL_DATE, else POSTED_ON days back", () => {
  assert.equal(manappuramPostedAt(row()), "2026-10-07T00:00:00.000Z");
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(manappuramPostedAt(row({ APPROVAL_DATE: null }), now), "2026-10-07T12:00:00.000Z");
  assert.equal(manappuramPostedAt(row({ APPROVAL_DATE: null, POSTED_ON: null }), now), null);
});

test("listPostings posts the firm filter and maps rows with India-suffixed branch locations", async (t) => {
  const calls: Array<{ url: string; body: string }> = [];
  stubFetch(t, (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(jsonResponse(wrap({ Status: 200, Message: "Success", Data: [row(), row({ MRF_ID: 309.0, LOCATION: " OLD BUS STAND CENTER CUDAPAAH " })] })));
  });
  const p = await manappuramAdapter.listPostings(company);
  assert.equal(at(calls, 0).url, MANAPPURAM_LIST_URL);
  assert.deepEqual(JSON.parse(at(calls, 0).body), {
    p_firm_id: 296191, p_searchtext: "", p_sort_id: 0, p_dept: "", p_state: "", p_dist: "", p_loc: "",
  });
  assert.equal(p.length, 2);
  const p0 = at(p, 0);
  assert.equal(p0.provider, "manappuram");
  assert.equal(p0.externalId, "482");
  assert.equal(p0.jobTitle, "DEVELOPER TRAINEE");
  assert.equal(p0.location, "A.O.VALAPAD, India");
  assert.equal(p0.jobUrl, `${MANAPPURAM_PORTAL_URL}#mrf-482`);
  assert.equal(p0.postedAt, "2026-10-07T00:00:00.000Z");
  assert.equal(p0.jdText, "");
  assert.equal(at(p, 1).location, "OLD BUS STAND CENTER CUDAPAAH, India");
});

const detail = (over: Record<string, string | number | null> = {}) => ({
  MRF_ID: 482.0, DEPT_NAME: "HRM (T)", SUB_DEPT_NAME: "L & D TECHNOLOGY", POSITION_NAME: "DEVELOPER TRAINEE",
  DESIGNATION_NAME: "JR. ASST.", VACANCY: 1.0, EXPERIENCE: "0-2", CTC: 500000.0, LOCATION: "A.O.VALAPAD",
  JOB_DESCRIPTION: "• Curriculum Design: Build course outlines.\n• Training Delivery: Conduct sessions.",
  SKILLS: "Teaching, JavaScript", RESPONSIBILITIES: "Run the developer bootcamp.", QUALIFICATION: "GRADUATE in B.TECH(IT)",
  ...over,
});

test("manappuramJdFromDetail builds the JD from the detail rows, listing every qualification", () => {
  const jd = manappuramJdFromDetail(asJson(wrap({
    Status: 200, Message: "Success",
    Data: [detail(), detail({ QUALIFICATION: "POST GRADUATE in MCA" })],
  })));
  assert.match(jd, /Curriculum Design/);
  assert.match(jd, /Run the developer bootcamp/);
  assert.match(jd, /Teaching, JavaScript/);
  assert.match(jd, /Experience: 0-2 years/);
  assert.match(jd, /GRADUATE in B\.TECH\(IT\)/);
  assert.match(jd, /POST GRADUATE in MCA/);
  assert.match(jd, /Department: HRM \(T\) \/ L & D TECHNOLOGY/);
});

test("manappuramJdFromDetail returns empty for an empty or malformed detail", () => {
  assert.equal(manappuramJdFromDetail(asJson(wrap({ Status: 200, Message: "Success", Data: [] }))), "");
  assert.equal(manappuramJdFromDetail(asJson({ nope: 1 })), "");
});

test("fetchJd posts firm + MRF id to the jobDescription page method", async (t) => {
  const calls: Array<{ url: string; body: string }> = [];
  stubFetch(t, (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(jsonResponse(wrap({ Status: 200, Message: "Success", Data: [detail()] })));
  });
  const posting = {
    provider: "manappuram", externalId: "482", companySlug: "manappuram-finance", companyName: "Manappuram Finance",
    jobTitle: "DEVELOPER TRAINEE", jobUrl: MANAPPURAM_PORTAL_URL, location: "A.O.VALAPAD, India", isRemote: false, jdText: "", postedAt: null,
  } as const;
  const jd = await manappuramAdapter.fetchJd?.(company, { ...posting });
  assert.match(jd ?? "", /Curriculum Design/);
  assert.equal(at(calls, 0).url, MANAPPURAM_JD_URL);
  assert.deepEqual(JSON.parse(at(calls, 0).body), { P_FIRMID: 296191, P_MRF_ID: 482 });
});
