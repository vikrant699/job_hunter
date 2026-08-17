// The regression this file pins: procmart's WP REST collection endpoint hangs
// the origin (503 / 20s+ stall, cf reached 5 and the row went broken between
// 2026-08-03 and 2026-08-15) whenever `_fields` includes `content` — verified
// live 2026-08-17: per_page=100 without content answers in ~0.3s, ANY collection
// query with content never answers, and single-page content fetches answer in
// ~0.5s. So the adapter must list WITHOUT content and fetch each job page's
// content individually.
import { test } from "node:test";
import assert from "node:assert/strict";
import { procmartAdapter, procmartTitle } from "../procmart.js";
import { stubFetch, jsonResponse, mkAdapterCompany, at } from "./testHelpers.js";

const COMPANY = mkAdapterCompany({
  provider: "procmart",
  slug: "procmart",
  name: "ProcMart",
  careersUrl: "https://www.procmart.com/procmartcareers/",
});

const LIST_BODY = [
  { id: 9186, slug: "contact", link: "https://www.procmart.com/contact/" },
  { id: 6813, slug: "job-opening-1", link: "https://www.procmart.com/job-opening-1/" },
  { id: 6868, slug: "job-opening-2", link: "https://www.procmart.com/job-opening-2/" },
];

function detailBody(id: number, slug: string, title: string): {
  id: number; slug: string; link: string; content: { rendered: string };
} {
  return {
    id,
    slug,
    link: `https://www.procmart.com/${slug}/`,
    content: { rendered: `<div class="elementor"><h2>${title}</h2><p>Own the sourcing funnel.</p></div>` },
  };
}

test("procmart lists without content, then fetches each job page's content individually", async (t) => {
  const urls: string[] = [];
  stubFetch(t, (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/wp-json/wp/v2/pages?")) return Promise.resolve(jsonResponse(LIST_BODY));
    if (url.includes("/wp-json/wp/v2/pages/6813")) return Promise.resolve(jsonResponse(detailBody(6813, "job-opening-1", "Assistant Manager - Procurement")));
    if (url.includes("/wp-json/wp/v2/pages/6868")) return Promise.resolve(jsonResponse(detailBody(6868, "job-opening-2", "Key Account Manager")));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  const postings = await procmartAdapter.listPostings(COMPANY);

  // The collection query must NEVER ask for content — that is the exact query
  // that hangs the origin and broke the row.
  const listCalls = urls.filter((u) => u.includes("/wp-json/wp/v2/pages?"));
  assert.equal(listCalls.length, 1);
  assert.ok(!at(listCalls, 0).includes("content"), "collection query must not request the content field");

  // One detail fetch per job page, none for the non-job page.
  assert.equal(urls.filter((u) => u.includes("/wp-json/wp/v2/pages/")).length, 2);
  assert.ok(!urls.some((u) => u.includes("/wp-json/wp/v2/pages/9186")), "non-job pages must not be fetched");

  assert.equal(postings.length, 2);
  const first = at(postings, 0);
  assert.equal(first.jobTitle, "Assistant Manager - Procurement");
  assert.equal(first.externalId, "6813");
  assert.equal(first.jobUrl, "https://www.procmart.com/job-opening-1/");
  assert.equal(first.location, "India");
  assert.match(first.jdText, /Own the sourcing funnel/);
});

test("procmart skips a job page whose content has no h2 title", async (t) => {
  stubFetch(t, (input) => {
    const url = String(input);
    if (url.includes("/wp-json/wp/v2/pages?")) {
      return Promise.resolve(jsonResponse([{ id: 1, slug: "job-opening-9", link: "https://www.procmart.com/job-opening-9/" }]));
    }
    return Promise.resolve(jsonResponse({ id: 1, slug: "job-opening-9", link: null, content: { rendered: "<p>no heading here</p>" } }));
  });
  const postings = await procmartAdapter.listPostings(COMPANY);
  assert.equal(postings.length, 0);
});

test("procmartTitle takes the first h2's text and null when absent", () => {
  assert.equal(procmartTitle("<div><h2 class=\"x\">Sr. <b>Buyer</b></h2><h2>Other</h2></div>"), "Sr. Buyer");
  assert.equal(procmartTitle("<p>none</p>"), null);
});
