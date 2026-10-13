import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTextJobs } from "../extractTextJobs.js";

test("selectTextJobs keeps valid jobs and drops empty/nav titles without failing the batch", () => {
  const raw = [
    { title: "Senior Data Analyst", location: "Bangalore" },
    { title: "", location: "Mumbai" },
    { title: "Apply now" },
    { location: "Pune" },
    { title: "Business Analyst", location: "Full-time" },
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
