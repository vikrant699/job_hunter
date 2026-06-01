// src/eval/dataset.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildLabeledPostings } from "./dataset.js";

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE companies (provider TEXT, slug TEXT, name TEXT);
    CREATE TABLE postings (
      provider TEXT, external_id TEXT, company_slug TEXT, job_title TEXT,
      jd_text TEXT, llm_confidence REAL, notified_at TEXT
    );
    INSERT INTO companies VALUES ('workday','acme','Acme India');
    INSERT INTO postings VALUES ('workday','R1','acme','Data Analyst','JD one',0.5,'2026-05-20');
    INSERT INTO postings VALUES ('workday','R2','acme','Android Eng','JD two',0.7,'2026-05-20');
    INSERT INTO postings VALUES ('workday','R3','acme','Unlabeled','JD three',0.4,'2026-05-20');
  `);
  return db;
}

test("joins only labeled, notified postings and carries jd + stored score", () => {
  const db = seed();
  const labels = new Map([["workday:R1", true], ["workday:R2", false]]);
  const rows = buildLabeledPostings(db, labels);
  db.close();

  assert.equal(rows.length, 2); // R3 has no label → excluded
  const r1 = rows.find((r) => r.id === "workday:R1")!;
  assert.equal(r1.company, "Acme India");
  assert.equal(r1.title, "Data Analyst");
  assert.equal(r1.jdText, "JD one");
  assert.equal(r1.storedScore, 0.5);
  assert.equal(r1.relevant, true);
});
