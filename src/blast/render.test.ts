// src/blast/render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBJECTS, companyForMention, loadBlastTemplate, renderBlast, type BlastTemplate } from "./render.js";

const TEMPLATE: BlastTemplate = {
  body: "{{greeting}}\n\n{{opener}}\n\nFixed body.\n\nBest regards,\nDivya\n",
};

test("companyForMention accepts clean names and trims marketing tails after '|'", () => {
  assert.equal(companyForMention("Adept Consultants"), "Adept Consultants");
  assert.equal(companyForMention("Synarion IT Solutions | Leading IT Solutions Company"), "Synarion IT Solutions");
});

test("companyForMention rejects junk", () => {
  assert.equal(companyForMention("(unknown)"), null);
  assert.equal(companyForMention("C"), null);
  assert.equal(companyForMention("SS"), null);
  assert.equal(companyForMention("a prestigious European-based client"), null);
  assert.equal(companyForMention("The best staffing firm in town"), null);
  assert.equal(companyForMention("12345"), null);
  assert.equal(
    companyForMention("Lab for Spatial Informatics at International Institute of Information Technology Hyderabad (IIITH)"),
    null,
  );
});

test("rotation walks all 9 subject/opener combos before repeating", () => {
  const combos = new Set<string>();
  for (let i = 0; i < 9; i++) {
    const r = renderBlast({ template: TEMPLATE, company: "Adept Consultants", contactName: null, rotationIndex: i });
    combos.add(r.variant);
  }
  assert.equal(combos.size, 9);
  const r0 = renderBlast({ template: TEMPLATE, company: "Adept Consultants", contactName: null, rotationIndex: 0 });
  assert.equal(r0.variant, "S1/O1");
  assert.equal(r0.subject, SUBJECTS[0]);
  const r4 = renderBlast({ template: TEMPLATE, company: "Adept Consultants", contactName: null, rotationIndex: 4 });
  assert.equal(r4.variant, "S2/O2");
});

test("company mention appears in the opener; failed gate falls back and tags the variant", () => {
  const withCo = renderBlast({ template: TEMPLATE, company: "Adept Consultants", contactName: null, rotationIndex: 0 });
  assert.match(withCo.bodyText, /your team at Adept Consultants may be hiring for/);
  const fallback = renderBlast({ template: TEMPLATE, company: "(unknown)", contactName: null, rotationIndex: 0 });
  assert.match(fallback.bodyText, /opportunities that you may be hiring for/);
  assert.equal(fallback.variant, "S1/O1-fallback");
});

test("greeting uses the first name when present, plain 'Hi,' otherwise", () => {
  const named = renderBlast({ template: TEMPLATE, company: "X", contactName: "Shriankhla Saxena", rotationIndex: 0 });
  assert.match(named.bodyText, /^Hi Shriankhla,/);
  const anon = renderBlast({ template: TEMPLATE, company: "X", contactName: null, rotationIndex: 0 });
  assert.match(anon.bodyText, /^Hi,/);
});

test("replacement-pattern characters in inputs are inserted literally", () => {
  const r = renderBlast({ template: TEMPLATE, company: "X", contactName: "$& Kumar", rotationIndex: 0 });
  assert.equal(r.bodyText.includes("Hi $&,"), true);
  assert.equal(r.bodyText.includes("{{greeting}}"), false);
});

test("no em dash in any subject or rendered body", () => {
  for (const s of SUBJECTS) assert.equal(s.includes("—"), false);
  for (let i = 0; i < 9; i++) {
    const r = renderBlast({ template: TEMPLATE, company: "Adept Consultants", contactName: null, rotationIndex: i });
    assert.equal(r.bodyText.includes("—"), false);
  }
});

test("loadBlastTemplate validates tokens and bans em dashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "blast-template-"));
  try {
    const good = join(dir, "good.md");
    writeFileSync(good, "{{greeting}}\n\n{{opener}}\n\nBody.\n", "utf-8");
    assert.equal(loadBlastTemplate(good).body.includes("{{opener}}"), true);

    const missing = join(dir, "missing.md");
    writeFileSync(missing, "{{greeting}}\n\nBody without opener.\n", "utf-8");
    assert.throws(() => loadBlastTemplate(missing), /\{\{opener\}\}/);

    const emdash = join(dir, "emdash.md");
    writeFileSync(emdash, "{{greeting}}\n\n{{opener}}\n\nBody — with dash.\n", "utf-8");
    assert.throws(() => loadBlastTemplate(emdash), /em dash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBlastTemplate rejects duplicate tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "blast-template-"));
  try {
    const dupe = join(dir, "dupe.md");
    writeFileSync(dupe, "{{greeting}}\n\n{{opener}}\n\n{{opener}}\n\nBody.\n", "utf-8");
    assert.throws(() => loadBlastTemplate(dupe), /exactly one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
