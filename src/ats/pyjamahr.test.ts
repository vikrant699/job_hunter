// src/ats/pyjamahr.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pyjamahrCompanyUuid,
  pyjamahrListUrl,
  pyjamahrJdUrl,
  pyjamahrBoardParam,
  pyjamahrJobUrl,
  pyjamahrLocation,
  parsePyjamahrList,
  parsePyjamahrDetail,
  normalizePyjamahr,
  PyjamahrJobSchema,
} from "./pyjamahr.js";
import type { PyjamahrJob } from "./pyjamahr.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "pyjamahr",
  slug: "smallcase",
  name: "smallcase",
  careersUrl: "https://app.pyjamahr.com/careers?company=smallcase&company_uuid=2615584222",
  tenantUrl: null,
  apiMeta: { companyUuid: "2615584222" },
};

// Trimmed real item from GET api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222
// (captured 2026-07-11).
const job: PyjamahrJob = {
  id: 375341,
  slug: "manager-senior-manager-finance",
  title: "Manager/Senior Manager- Finance",
  max_experience: 7.0,
  min_experience: 3.0,
  country: "India",
  location: "Bengaluru, Karnataka, India",
  other_locations: [],
  department_name: "Finance",
  workplace_type: "HYBRID",
};

const listResponse = {
  count: 23,
  next: "https://api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222&is_careers_page=true&page=2",
  previous: null,
  results: [job],
};

// Trimmed real detail from GET api.pyjamahr.com/api/career/jobs/375341/?company_uuid=2615584222
const detailResponse = {
  id: 375341,
  uuid: "501D96BC0F",
  title: "Manager/Senior Manager- Finance",
  job_type: "FULLTIME",
  description:
    "<p><strong>About the team</strong></p>\n<p>The Finance team at CASE Platforms acts as a steward for the organisation.</p>",
};

test("pyjamahrCompanyUuid reads apiMeta.companyUuid and throws when missing", () => {
  assert.equal(pyjamahrCompanyUuid(company), "2615584222");
  assert.throws(() => pyjamahrCompanyUuid({ ...company, apiMeta: null }), /companyUuid/);
  assert.throws(() => pyjamahrCompanyUuid({ ...company, apiMeta: {} }), /companyUuid/);
});

test("pyjamahrListUrl / pyjamahrJdUrl build the public API URLs", () => {
  assert.equal(
    pyjamahrListUrl("2615584222", 1),
    "https://api.pyjamahr.com/api/career/jobs/?company_uuid=2615584222&page=1&is_careers_page=true",
  );
  assert.equal(
    pyjamahrJdUrl("2615584222", "375341"),
    "https://api.pyjamahr.com/api/career/jobs/375341/?company_uuid=2615584222",
  );
});

test("pyjamahrBoardParam prefers the careersUrl ?company= param, falls back to slug", () => {
  assert.equal(pyjamahrBoardParam(company), "smallcase");
  assert.equal(pyjamahrBoardParam({ ...company, careersUrl: "https://example.com/careers" }), "smallcase");
});

test("pyjamahrJobUrl deep-links the board SPA by job slug (id fallback)", () => {
  assert.equal(
    pyjamahrJobUrl(company, job),
    "https://app.pyjamahr.com/careers/manager-senior-manager-finance?company=smallcase&company_uuid=2615584222",
  );
  assert.equal(
    pyjamahrJobUrl(company, { ...job, slug: null }),
    "https://app.pyjamahr.com/careers/375341?company=smallcase&company_uuid=2615584222",
  );
});

test("pyjamahrLocation combines location + other_locations + country without duplicates", () => {
  assert.equal(pyjamahrLocation(job), "Bengaluru, Karnataka, India");
  assert.equal(
    pyjamahrLocation({ ...job, other_locations: ["Mumbai, Maharashtra, India"] }),
    "Bengaluru, Karnataka, India; Mumbai, Maharashtra, India",
  );
  // country appended only when no other part already mentions it
  assert.equal(pyjamahrLocation({ ...job, location: "Bengaluru" }), "Bengaluru; India");
  assert.equal(pyjamahrLocation({ ...job, location: null, other_locations: [], country: null }), null);
});

test("parsePyjamahrList unwraps the DRF envelope", () => {
  const page = parsePyjamahrList(listResponse);
  assert.equal(page.count, 23);
  assert.equal(page.next, listResponse.next);
  assert.equal(page.results.length, 1);
  assert.equal(at(page.results, 0).title, "Manager/Senior Manager- Finance");
});

test("PyjamahrJobSchema tolerates missing optionals, rejects missing id/title", () => {
  assert.ok(PyjamahrJobSchema.safeParse({ id: 1, title: "x" }).success);
  assert.equal(PyjamahrJobSchema.safeParse({ title: "no id" }).success, false);
  assert.equal(PyjamahrJobSchema.safeParse({ id: 1 }).success, false);
});

test("parsePyjamahrDetail pulls the HTML description", () => {
  assert.match(parsePyjamahrDetail(detailResponse) ?? "", /About the team/);
  assert.equal(parsePyjamahrDetail({ id: 1 }), null);
});

test("normalizePyjamahr maps fields; jdText stays empty (fetchJd fills it)", () => {
  const p = normalizePyjamahr(company, job);
  assert.equal(p.provider, "pyjamahr");
  assert.equal(p.externalId, "375341");
  assert.equal(p.companySlug, "smallcase");
  assert.equal(p.jobTitle, "Manager/Senior Manager- Finance");
  assert.equal(p.location, "Bengaluru, Karnataka, India");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
  assert.equal(
    p.jobUrl,
    "https://app.pyjamahr.com/careers/manager-senior-manager-finance?company=smallcase&company_uuid=2615584222",
  );
});

test("normalizePyjamahr flags REMOTE workplace_type", () => {
  const p = normalizePyjamahr(company, { ...job, workplace_type: "REMOTE", location: "India" });
  assert.equal(p.isRemote, true);
});
