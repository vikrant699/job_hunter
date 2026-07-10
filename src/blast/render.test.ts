// src/blast/render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companyForMention, loadBlastTemplate, loadBlastContent, renderBlast,
  type BlastTemplate, type BlastContent,
} from "./render.js";

const TEMPLATE: BlastTemplate = {
  body: "{{greeting}}\n\n{{opener}}\n\nFixed body.\n\nBest regards,\nDivya\n",
};

/** 3x3 content mirroring the shipped shape (distinct marker strings). */
const CONTENT: BlastContent = {
  resumeFilename: "Divya Rajput Resume.pdf",
  subjects: ["Subject One", "Subject Two", "Subject Three"],
  openers: [
    {
      hello: "I hope you're doing well.",
      withCompany: "I am reaching out to explore opportunities that your team at {company} may be hiring for.",
      fallback: "I am reaching out to explore opportunities that you may be hiring for.",
    },
    {
      hello: "I hope your week is going well.",
      withCompany: "I'm writing to check whether you or your team at {company} are currently hiring.",
      fallback: "I'm writing to check whether you are currently hiring.",
    },
    {
      hello: "I hope you're doing well.",
      withCompany: "I wanted to share my profile with {company} for any openings.",
      fallback: "I wanted to share my profile for any openings.",
    },
  ],
};

function render(over: Partial<Parameters<typeof renderBlast>[0]>): ReturnType<typeof renderBlast> {
  return renderBlast({ template: TEMPLATE, content: CONTENT, company: "X", contactName: null, rotationIndex: 0, ...over });
}

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
    combos.add(render({ company: "Adept Consultants", rotationIndex: i }).variant);
  }
  assert.equal(combos.size, 9);
  const r0 = render({ company: "Adept Consultants", rotationIndex: 0 });
  assert.equal(r0.variant, "S1/O1");
  assert.equal(r0.subject, CONTENT.subjects[0]);
  const r4 = render({ company: "Adept Consultants", rotationIndex: 4 });
  assert.equal(r4.variant, "S2/O2");
});

test("company mention appears in the opener; failed gate falls back and tags the variant", () => {
  const withCo = render({ company: "Adept Consultants" });
  assert.match(withCo.bodyText, /your team at Adept Consultants may be hiring for/);
  const fallback = render({ company: "(unknown)" });
  assert.match(fallback.bodyText, /opportunities that you may be hiring for/);
  assert.equal(fallback.variant, "S1/O1-fallback");
});

test("greeting uses the first name when present, plain 'Hi,' otherwise", () => {
  const named = render({ contactName: "Shriankhla Saxena" });
  assert.match(named.bodyText, /^Hi Shriankhla,/);
  const anon = render({ contactName: null });
  assert.match(anon.bodyText, /^Hi,/);
});

test("replacement-pattern characters in inputs are inserted literally", () => {
  const r = render({ contactName: "$& Kumar" });
  assert.equal(r.bodyText.includes("Hi $&,"), true);
  assert.equal(r.bodyText.includes("{{greeting}}"), false);
  const co = render({ company: "R$&D Labs" });
  assert.equal(co.bodyText.includes("your team at R$&D Labs"), true);
});

test("no em dash in any rendered body across all combos", () => {
  for (let i = 0; i < 9; i++) {
    const r = render({ company: "Adept Consultants", rotationIndex: i });
    assert.equal(r.bodyText.includes("—"), false);
  }
});

test("loadBlastContent round-trips valid content and rejects bad shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "blast-content-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(CONTENT), "utf-8");
    assert.deepEqual(loadBlastContent(good), CONTENT);

    const noToken = join(dir, "no-token.json");
    writeFileSync(
      noToken,
      JSON.stringify({ ...CONTENT, openers: [{ hello: "Hi.", withCompany: "No token here.", fallback: "f" }] }),
      "utf-8",
    );
    assert.throws(() => loadBlastContent(noToken), /\{company\} token/);

    const emdash = join(dir, "emdash.json");
    writeFileSync(emdash, JSON.stringify({ ...CONTENT, subjects: ["Bad — subject"] }), "utf-8");
    assert.throws(() => loadBlastContent(emdash), /em dash/);

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, JSON.stringify({ subjects: [] }), "utf-8");
    assert.throws(() => loadBlastContent(malformed), /malformed/);

    const notJson = join(dir, "not-json.json");
    writeFileSync(notJson, "{oops", "utf-8");
    assert.throws(() => loadBlastContent(notJson), /unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
