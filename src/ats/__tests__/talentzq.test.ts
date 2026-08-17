import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TalentzqJobSchema,
  talentzqJobsFrom,
  talentzqShouldKeep,
  normalizeTalentzq,
  talentzqListUrl,
  talentzqDetailUrl,
  talentzqJobViewUrl,
  talentzqJdText,
} from "../talentzq.js";
import type { AdapterCompany } from "../../types.js";
import { JsonValueSchema } from "../../util/json.js";

const company: AdapterCompany = {
  provider: "talentzq", slug: "pratilipi", name: "Pratilipi",
  careersUrl: "https://pratilipi.talentzq.io/careers",
  tenantUrl: "https://pratilipi.talentzq.io",
  apiMeta: { tenantId: "1009" },
};

// The API double-JSON-encodes: the HTTP body is itself a JSON string wrapping the array's JSON text.
const publishedRecord = {
  Id: "6e18b9a0-92fd-4468-a7e0-98942c1fa843", Type: "jd", Tenantid: "1009",
  Title: "Bengali Content Operations Manager", Jdcode: "BOM-03-06",
  Status: "active", Jobcategory: "Pratilipi FM",
  Datecreated: "2026-06-03T11:18:14.5887797Z",
  Expectedenddate: "2026-08-13T00:00:00", Published: true, Priority: "normal",
  JobLocation: [["Bangalore", "Karnataka", "India"]],
  Jobtype: "fulltime", Experience: "junior",
  Skills: ["Content Operations", "Audio Content Operations"],
};
const unpublishedRecord = {
  Id: "bbc3a0f0-8e25-4d73-8c7d-fe0c8bc40797", Type: "jd", Tenantid: "1009",
  Title: "Business Development Executive", Jdcode: "BD-18-05-26",
  Status: "active", Jobcategory: "Indiepress",
  Datecreated: "2026-05-18T07:44:31.5863969Z",
  Expectedenddate: "2026-07-16T00:00:00", Published: false, Priority: "normal",
  JobLocation: [["Bangalore", "Karnataka", "India"]],
  Jobtype: "fulltime", Experience: "fresher",
  Skills: ["Business Development"],
};
const RAW_RECORDS = [publishedRecord, unpublishedRecord];
const DOUBLE_ENCODED_RESPONSE = JSON.stringify(JSON.stringify(RAW_RECORDS));

test("talentzqListUrl / talentzqDetailUrl / talentzqJobViewUrl build the tenant-scoped URLs (no ?v= needed)", () => {
  assert.equal(talentzqListUrl("https://pratilipi.talentzq.io", "1009"), "https://pratilipi.talentzq.io/api/1009/jd");
  assert.equal(
    talentzqDetailUrl("https://pratilipi.talentzq.io", "1009", "PIE-04"),
    "https://pratilipi.talentzq.io/api/1009/jd/PIE-04",
  );
  assert.equal(talentzqJobViewUrl("https://pratilipi.talentzq.io", "BOM-03-06"), "https://pratilipi.talentzq.io/JobView/BOM-03-06");
});

test("TalentzqJobSchema rejects a record with no id", () => {
  assert.equal(TalentzqJobSchema.safeParse({ Title: "No id", Jdcode: "X" }).success, false);
});

test("talentzqJobsFrom double-decodes the JSON-string-wrapped array", () => {
  const jobs = talentzqJobsFrom(JsonValueSchema.parse(JSON.parse(DOUBLE_ENCODED_RESPONSE)));
  assert.equal(jobs.length, 2);
});

test("talentzqJobsFrom tolerates malformed input by returning []", () => {
  assert.deepEqual(talentzqJobsFrom(null), []);
  assert.deepEqual(talentzqJobsFrom(42), []);
  assert.deepEqual(talentzqJobsFrom("not valid json"), []);
  assert.deepEqual(talentzqJobsFrom(JSON.stringify({ not: "an array" })), []);
});

test("talentzqShouldKeep keeps only Published === true records", () => {
  assert.equal(talentzqShouldKeep(TalentzqJobSchema.parse(publishedRecord)), true);
  assert.equal(talentzqShouldKeep(TalentzqJobSchema.parse(unpublishedRecord)), false);
});

test("normalizeTalentzq maps title/location(from JobLocation)/JobView URL/postedAt", () => {
  const p = normalizeTalentzq(company, "https://pratilipi.talentzq.io", TalentzqJobSchema.parse(publishedRecord));
  assert.equal(p.provider, "talentzq");
  assert.equal(p.externalId, "6e18b9a0-92fd-4468-a7e0-98942c1fa843");
  assert.equal(p.jobTitle, "Bengali Content Operations Manager");
  assert.equal(p.location, "Bangalore, Karnataka, India");
  assert.equal(p.jobUrl, "https://pratilipi.talentzq.io/JobView/BOM-03-06");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, new Date("2026-06-03T11:18:14.5887797Z").toISOString());
});

test("normalizeTalentzq detects remote and handles a missing JobLocation as null", () => {
  const remoteJob = TalentzqJobSchema.parse({
    Id: "r1", Title: "Remote Role", Jdcode: "R1", JobLocation: [["Remote", "", "India"]],
  });
  assert.equal(normalizeTalentzq(company, "https://pratilipi.talentzq.io", remoteJob).isRemote, true);

  const noLocJob = TalentzqJobSchema.parse({ Id: "r2", Title: "No Location Role", Jdcode: "R2" });
  const p = normalizeTalentzq(company, "https://pratilipi.talentzq.io", noLocJob);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("talentzqJdText strips HTML from the (singly-encoded) detail response, empty on non-string", () => {
  assert.equal(talentzqJdText("<h6><strong>About the Team</strong></h6><p>Build things.</p>"), "About the Team\nBuild things.");
  assert.equal(talentzqJdText(null), "");
  assert.equal(talentzqJdText(404), "");
});
