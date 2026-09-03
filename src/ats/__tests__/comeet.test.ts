import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractComeetPositions,
  extractComeetPosition,
  comeetLocationString,
  comeetJdFromDetails,
  normalizeComeet,
  ComeetPositionSchema,
} from "../comeet.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "comeet", slug: "algosec", name: "AlgoSec",
  careersUrl: "https://www.comeet.com/jobs/algosec/71.006", tenantUrl: null, apiMeta: null,
};

// Position shapes captured from the live AlgoSec board.
const positions = [
  {
    name: "Backend Developer, India",
    department: "R&D",
    email: "algosec.3E.C6D@applynow.io",
    location: {
      name: "India", country: "IN", city: "New Delhi", state: "India",
      postal_code: null, timezone: "Asia/Jerusalem", location_uid: "D4.006", is_remote: false,
    },
    url_comeet_hosted_page: "https://www.comeet.com/jobs/algosec/71.006/backend-developer-india/3E.C6D",
    url_active_page: "https://www.algosec.com/position/backend-developer-india/3e-c6d",
    employment_type: "Full-time",
    experience_level: null,
    uid: "3E.C6D",
    custom_fields: {
      details: [
        { name: "Description", value: "<p>At AlgoSec, what you do matters. Build the <strong>backend</strong> of our platform.</p>" },
        { name: "Requirements", value: "<ul><li>5+ years with Java</li><li>Cloud experience</li></ul>" },
      ],
    },
    time_updated: "2026-06-26T18:33:24Z",
    is_internal: false,
    workplace_type: "Hybrid",
  },
  {
    name: "AlgoSec Resident Engineer, Americas",
    location: {
      name: "US", country: "US", city: "United states", state: "New Jersey", is_remote: true,
    },
    url_comeet_hosted_page: "https://www.comeet.com/jobs/algosec/71.006/algosec-resident-engineer-americas/66.A63",
    uid: "66.A63",
    custom_fields: { details: [] },
    time_updated: "not-a-date",
    is_internal: false,
    workplace_type: "Remote",
  },
  {
    name: "Internal Only Role",
    uid: "00.INT",
    is_internal: true,
    location: null,
    custom_fields: null,
  },
];

// Mirrors the live page: array embedded one-per-line, var declared bare above it, POSITION_DATA = null alongside.
const boardHtml = `<html><head><script>
       var COMPANY_POSITIONS_DATA ;
       var POSITION_DATA ;
       COMPANY_DATA = {"name": "AlgoSec", "location": "Israel"};
       COMPANY_POSITIONS_DATA = ${JSON.stringify(positions)};
       POSITION_DATA = null;
</script></head><body></body></html>`;

// Position detail page: same object shape under POSITION_DATA (board array is null).
const positionHtml = `<html><head><script>
       var COMPANY_POSITIONS_DATA ;
       COMPANY_POSITIONS_DATA = null;
       POSITION_DATA = ${JSON.stringify(positions[0])};
</script></head><body></body></html>`;

test("extractComeetPositions parses the COMPANY_POSITIONS_DATA island, ignoring the null POSITION_DATA", () => {
  const arr = extractComeetPositions(boardHtml);
  assert.ok(arr);
  assert.equal(arr.length, 3);
});

test("extractComeetPositions returns null when the island is absent or null", () => {
  assert.equal(extractComeetPositions("<html>nothing</html>"), null);
  assert.equal(extractComeetPositions("<script>COMPANY_POSITIONS_DATA = null;</script>"), null);
});

test("extractComeetPosition parses the POSITION_DATA island on a detail page", () => {
  const pos = extractComeetPosition(positionHtml);
  assert.ok(pos);
  const parsed = ComeetPositionSchema.parse(pos);
  assert.equal(parsed.uid, "3E.C6D");
});

test("extractComeetPosition ignores the bare declaration and null board array", () => {
  assert.equal(extractComeetPosition(boardHtml), null);
});

test("comeetLocationString composes city + name, skipping a name the city already implies", () => {
  assert.equal(
    comeetLocationString({ name: "India", country: "IN", city: "New Delhi", state: "India", is_remote: false }),
    "New Delhi, India",
  );
  // name repeats the city -> city alone
  assert.equal(
    comeetLocationString({ name: "New Delhi", country: "IN", city: "New Delhi", is_remote: false }),
    "New Delhi",
  );
  // name contains the city (cognyte live shape) -> the fuller name alone
  assert.equal(
    comeetLocationString({ name: "Pune, India", country: "IN", city: "Pune", is_remote: false }),
    "Pune, India",
  );
  assert.equal(comeetLocationString({ country: "IL" }), "IL");
  assert.equal(comeetLocationString(null), null);
  assert.equal(comeetLocationString(undefined), null);
});

test("comeetJdFromDetails labels and joins the sections as plain text", () => {
  const parsed = ComeetPositionSchema.parse(positions[0]);
  const jd = comeetJdFromDetails(parsed);
  assert.match(jd, /Description\n/);
  assert.match(jd, /Requirements\n/);
  assert.match(jd, /backend of our platform/);
  assert.match(jd, /5\+ years with Java/);
  assert.doesNotMatch(jd, /<p>|<li>|<strong>/);
});

test("normalizeComeet maps fields (uid id, hosted-page URL, ISO postedAt)", () => {
  const p = normalizeComeet(company, ComeetPositionSchema.parse(positions[0]));
  assert.equal(p.provider, "comeet");
  assert.equal(p.externalId, "3E.C6D");
  assert.equal(p.jobTitle, "Backend Developer, India");
  assert.equal(p.jobUrl, "https://www.comeet.com/jobs/algosec/71.006/backend-developer-india/3E.C6D");
  assert.equal(p.location, "New Delhi, India");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /backend of our platform/);
  assert.equal(p.postedAt, "2026-06-26T18:33:24.000Z");
});

test("normalizeComeet: location.is_remote/Remote workplace set isRemote; bad date maps to null", () => {
  const p = normalizeComeet(company, ComeetPositionSchema.parse(positions[1]));
  assert.equal(p.isRemote, true);
  assert.equal(p.postedAt, null);
  assert.equal(p.jdText, "");
  assert.equal(p.location, "United states, US");
});
