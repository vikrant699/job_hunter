import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecrewJd, parseRecrewList, recrewAdapter, recrewModalUrl } from "../recrew.js";
import { at, htmlResponse, mkAdapterCompany, stubFetch } from "./testHelpers.js";

const company = mkAdapterCompany({
  provider: "recrew",
  slug: "recrew",
  name: "Recrew",
  careersUrl: "https://talent.recrew.ai/careers/",
});

const card = (uuid: string, title: string, loc: string, workplace = "onsite") => `
  <div class="job-card" data-job-uuid="${uuid}" data-detail-url="/job/job-board/${uuid}/detail/modal"
       data-title="${title.toLowerCase()}" data-location="${loc}" data-workplace="${workplace}">
    <div class="job-header"><h3 class="job-title">${title}</h3><button>Apply</button></div>
  </div>`;

const LIST = `<html><body>
  ${card("7dc03655-968d-45f4-8cb3-59fb708b51c6", "Frontend Engineer", "bangalore")}
  ${card("7dc03655-968d-45f4-8cb3-59fb708b51c6", "Frontend Engineer", "bangalore")}
  ${card("f843903a-ce1e-4d66-a2c4-d2703cdf73a9", "Senior React Native Developer", "india", "remote")}
  ${card("5e0d8220-e627-4584-8a05-6d529d8ff8a8", "Leave your Resume with Recrew", "india", "remote")}
</body></html>`;

test("parseRecrewList dedupes the doubled cards, drops the resume-drop card, maps location/remote", () => {
  const out = parseRecrewList(LIST, company);
  assert.equal(out.length, 2);
  const fe = at(out, 0);
  const rn = at(out, 1);
  assert.equal(fe.externalId, "7dc03655-968d-45f4-8cb3-59fb708b51c6");
  assert.equal(fe.jobTitle, "Frontend Engineer");
  assert.equal(fe.location, "Bangalore");
  assert.equal(fe.isRemote, false);
  assert.equal(fe.jobUrl, "https://talent.recrew.ai/careers/?job=7dc03655-968d-45f4-8cb3-59fb708b51c6");
  assert.equal(rn.isRemote, true);
  assert.equal(rn.jdText, "");
});

test("parseRecrewJd strips chrome and keeps the description text", () => {
  const modal = `<div><h2>Frontend Engineer <span>Onsite</span></h2><button id="modal-close-btn">x</button>
    <p>About Company</p><p>The company is a cloud-based tutor management platform.</p>
    <form action="/form/apply/x/submit/"><input name="email"></form><script>bad()</script></div>`;
  const text = parseRecrewJd(modal);
  assert.match(text, /tutor management platform/);
  assert.doesNotMatch(text, /bad\(\)|email/);
});

test("fetchJd hits the modal endpoint with the XHR header", async (t) => {
  let seenUrl = "";
  let seenHeader: string | null = null;
  stubFetch(t, async (input, init) => {
    seenUrl = String(input);
    seenHeader = new Headers(init?.headers).get("x-requested-with");
    return htmlResponse("<div><p>Role details here.</p></div>");
  });
  const posting = at(parseRecrewList(LIST, company), 0);
  assert.ok(recrewAdapter.fetchJd);
  const jd = await recrewAdapter.fetchJd(company, posting);
  assert.equal(seenUrl, recrewModalUrl(company, posting.externalId));
  assert.equal(seenHeader, "XMLHttpRequest");
  assert.match(jd, /Role details here/);
});
