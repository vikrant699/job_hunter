import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTextJobs } from "../extract-text-jobs.js";

test("selectTextJobs keeps valid jobs and drops empty/nav titles without failing the batch", () => {
  const raw = [
    { title: "Senior Data Analyst", location: "Bangalore" },
    { title: "", location: "Mumbai" }, // empty → dropped
    { title: "Apply now" }, // nav phrase → dropped
    { location: "Pune" }, // missing title → dropped, batch survives
    { title: "Business Analyst", location: "Full-time" }, // bogus location stripped
  ];
  const out = selectTextJobs(raw);
  assert.deepEqual(
    out,
    [
      { title: "Senior Data Analyst", location: "Bangalore" },
      { title: "Business Analyst", location: null },
    ],
  );
});
