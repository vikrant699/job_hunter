import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenMagicpinJobs, normalizeMagicpin, magicpinJdFromDetail } from "../magicpin.js";
import type { MagicpinListJob } from "../magicpin.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "magicpin",
  slug: "magicpin",
  name: "magicpin",
  careersUrl: "https://magicpin.in/careers",
  tenantUrl: null,
  apiMeta: null,
};

// Real shape of GET https://sales.magicpin.in/magickiosk/career/jobs.
const LIST_FIXTURE = [
  {
    _id: "tech",
    count: 2,
    jobs: [
      { _id: "6514c3c24280af82eaa5bb49", title: "SDE-1", experience: "FRESHER", location: "WFO", employmentType: "PERM" },
      { _id: "65e9a66a130b3ee7c4396aff", title: "Java developer", experience: "1-4 Yrs", location: "Gurugram", employmentType: "Full-time" },
    ],
  },
  {
    _id: "growth",
    count: 1,
    jobs: [
      { _id: "65f93f77d9fdfc96bc5b1db2", title: "Sr. Business Development Associate", experience: "1-6 Yrs", location: "Delhi, Hyderabad, Mumbai", employmentType: "Full-time" },
    ],
  },
  {
    _id: "brands",
    count: 1,
    jobs: [
      { _id: "65f94146d9fdfc96bc5b2828", title: "AM- Brands", experience: "1-6 Yeas", location: "Gurgaon", employmentType: "PERM" },
    ],
  },
];

const job: MagicpinListJob = {
  _id: "65e9a66a130b3ee7c4396aff",
  title: "Java developer",
  experience: "1-4 Yrs",
  location: "Gurugram",
  employmentType: "Full-time",
};

test("flattenMagicpinJobs flattens the department-grouped jobs[] arrays into one list", () => {
  const jobs = flattenMagicpinJobs(LIST_FIXTURE);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((j) => j.title), ["SDE-1", "Java developer", "Sr. Business Development Associate", "AM- Brands"]);
});

test("flattenMagicpinJobs tolerates an empty department group", () => {
  const jobs = flattenMagicpinJobs([{ _id: "empty-dept", count: 0, jobs: [] }]);
  assert.deepEqual(jobs, []);
});

test("normalizeMagicpin maps fields: jobdescription URL with jobId param, raw location, empty jdText pending fetchJd", () => {
  const p = normalizeMagicpin(company, job);
  assert.equal(p.provider, "magicpin");
  assert.equal(p.externalId, "65e9a66a130b3ee7c4396aff");
  assert.equal(p.jobTitle, "Java developer");
  assert.equal(p.jobUrl, "https://magicpin.in/careers/jobdescription?jobId=65e9a66a130b3ee7c4396aff");
  assert.equal(p.location, "Gurugram");
  assert.equal(p.isRemote, false);
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeMagicpin does not flag \"WFO\" (work-from-office) as remote", () => {
  const p = normalizeMagicpin(company, { ...job, location: "WFO" });
  assert.equal(p.isRemote, false);
  assert.equal(p.location, "WFO");
});

test("normalizeMagicpin flags remote when the location string matches REMOTE_RE", () => {
  const p = normalizeMagicpin(company, { ...job, location: "Remote (Work From Home)" });
  assert.equal(p.isRemote, true);
});

test("normalizeMagicpin treats a missing location as null", () => {
  const p = normalizeMagicpin(company, { ...job, location: null });
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

// Real shape of GET https://sales.magicpin.in/magickiosk/career/jobs/<id>.
test("magicpinJdFromDetail strips HTML from requirements and appends plain-text responsibilities", () => {
  const detail = {
    _id: "65e9a66a130b3ee7c4396aff",
    department: "Tech",
    title: "Java developer",
    requirements: "<p><br></p>",
    responsibilities: "•\tB.E./B.Tech in Computer science or equivalent degree with 5+ Yrs work experience",
    inactive: false,
  };
  const jd = magicpinJdFromDetail(detail, { slug: "magicpin", jobId: "65e9a66a130b3ee7c4396aff" });
  assert.match(jd, /B\.E\.\/B\.Tech/);
  assert.doesNotMatch(jd, /<p>|<br>/);
});

test("magicpinJdFromDetail joins requirements HTML and responsibilities when both are present", () => {
  const detail = {
    _id: "65f93f77d9fdfc96bc5b1db2",
    requirements: "<p>Job Description :</p>\n<p>· This is a B2B sales (Field) role.</p>",
    responsibilities: "",
  };
  const jd = magicpinJdFromDetail(detail, { slug: "magicpin", jobId: "65f93f77d9fdfc96bc5b1db2" });
  assert.match(jd, /B2B sales/);
});

test("magicpinJdFromDetail returns empty string when both requirements and responsibilities are empty", () => {
  const detail = { _id: "6514c3c24280af82eaa5bb49", requirements: "<p><br></p>", responsibilities: "" };
  const jd = magicpinJdFromDetail(detail, { slug: "magicpin", jobId: "6514c3c24280af82eaa5bb49" });
  assert.equal(jd, "");
});

test("magicpinJdFromDetail returns empty string and logs on a schema mismatch instead of throwing", () => {
  const jd = magicpinJdFromDetail({ unexpected: "shape" }, { slug: "magicpin", jobId: "bad-id" });
  assert.equal(jd, "");
});
