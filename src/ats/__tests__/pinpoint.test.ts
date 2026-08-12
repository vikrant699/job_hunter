// src/ats/__tests__/pinpoint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pinpointBase,
  pinpointLocation,
  normalizePinpoint,
  postingsFromPinpointJson,
} from "../pinpoint.js";
import type { AdapterCompany } from "../../types.js";
import { asJson } from "./testHelpers.js";

const company: AdapterCompany = {
  provider: "pinpoint",
  slug: "hiver",
  name: "Hiver",
  careersUrl: "https://hiverhq.com/careers",
  tenantUrl: "https://hiverhq.pinpointhq.com",
  apiMeta: null,
};

// Trimmed real item from GET https://hiverhq.pinpointhq.com/postings.json (2026-08-12).
const rawPosting = {
  id: "524572",
  title: "Principal Engineer",
  description: "<div><strong>About Hiver</strong></div><div>We build software.</div>",
  employment_type_text: "Full-time",
  workplace_type: "hybrid",
  workplace_type_text: "Hybrid",
  url: "https://hiverhq.pinpointhq.com/en/postings/1261f9dc-eddf-404a-a496-a7f110db5910",
  location: { id: "86155", city: "Bengaluru", name: "Bangalore - India", province: "Karnataka" },
};

test("pinpointBase prefers the tenant_url host, else builds <slug>.pinpointhq.com", () => {
  assert.equal(pinpointBase(company), "https://hiverhq.pinpointhq.com");
  assert.equal(
    pinpointBase({ ...company, tenantUrl: null }),
    "https://hiver.pinpointhq.com",
  );
  // apiMeta.boardSlug wins over the registry slug when the subdomain differs.
  assert.equal(
    pinpointBase({ ...company, tenantUrl: null, apiMeta: { boardSlug: "hiverhq" } }),
    "https://hiverhq.pinpointhq.com",
  );
});

test("pinpointLocation joins city + province, falls back to name, else null", () => {
  assert.equal(pinpointLocation({ city: "Bengaluru", province: "Karnataka" }), "Bengaluru, Karnataka");
  assert.equal(pinpointLocation({ name: "Bangalore - India" }), "Bangalore - India");
  assert.equal(pinpointLocation({ city: "London" }), "London");
  assert.equal(pinpointLocation(null), null);
  assert.equal(pinpointLocation({}), null);
});

test("normalizePinpoint maps id, title, url, location, JD; workplace_type=remote flags remote", () => {
  const p = normalizePinpoint(company, {
    id: "524572",
    title: "Principal Engineer",
    description: "<div>We build <strong>software</strong>.</div>",
    workplace_type: "hybrid",
    url: "https://hiverhq.pinpointhq.com/en/postings/abc",
    location: { city: "Bengaluru", province: "Karnataka" },
  });
  assert.equal(p.provider, "pinpoint");
  assert.equal(p.externalId, "524572");
  assert.equal(p.jobTitle, "Principal Engineer");
  assert.equal(p.jobUrl, "https://hiverhq.pinpointhq.com/en/postings/abc");
  assert.equal(p.location, "Bengaluru, Karnataka");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /We build software\./);
});

test("normalizePinpoint flags isRemote when workplace_type is remote", () => {
  const p = normalizePinpoint(company, {
    id: "1", title: "Remote Dev", description: "x", workplace_type: "remote",
    url: "https://x/p/1", location: { name: "Remote" },
  });
  assert.equal(p.isRemote, true);
});

test("postingsFromPinpointJson validates the {data:[...]} envelope and maps every row", () => {
  const posts = postingsFromPinpointJson(company, asJson({ data: [rawPosting, { ...rawPosting, id: "2" }] }));
  assert.equal(posts.length, 2);
  const [first, second] = posts;
  assert.equal(first?.externalId, "524572");
  assert.equal(second?.externalId, "2");
  assert.equal(first.location, "Bengaluru, Karnataka");
});

test("postingsFromPinpointJson returns [] for an empty board", () => {
  assert.deepEqual(postingsFromPinpointJson(company, asJson({ data: [] })), []);
});

test("postingsFromPinpointJson throws on a wrong-shaped envelope (field drift)", () => {
  assert.throws(() => postingsFromPinpointJson(company, asJson({ jobs: [] })), /schema/);
});
