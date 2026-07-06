import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplate, renderDraft } from "./template.js";

function withTempFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "outreach-template-"));
  const path = join(dir, "template.md");
  writeFileSync(path, contents, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadTemplate splits the Subject line from the body", () => {
  withTempFile("Subject: Hello {{company}}\n\nBody line one\nBody line two\n", (path) => {
    const template = loadTemplate(path);
    assert.equal(template.subject, "Hello {{company}}");
    assert.equal(template.body, "Body line one\nBody line two\n");
  });
});

test("loadTemplate throws an actionable error when the Subject line is missing", () => {
  withTempFile("No subject here\n\nBody\n", (path) => {
    assert.throws(() => loadTemplate(path), /Subject:/);
  });
});

test("loadTemplate throws an actionable error when there's no blank line after Subject", () => {
  withTempFile("Subject: Hi\nBody immediately follows\n", (path) => {
    assert.throws(() => loadTemplate(path), /blank line/i);
  });
});

const baseTemplate = {
  subject: "Application for {{role_summary}} - {{sender_name}}",
  body: [
    "Hi {{contact_name_or_there}},",
    "",
    "I came across {{company}}'s opening{{s_if_plural}} for:",
    "",
    "{{roles_block}}",
    "",
    "{{profile_pitch}}My resume is attached; I'd love to be considered for the role{{s_if_plural}}.",
    "",
    "Best regards,",
    "{{sender_name}}",
    "{{sender_links}}",
    "",
  ].join("\n"),
};

test("renderDraft with a single role: no plural, first-title summary", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: "Jane Doe",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/jobs/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });

  assert.equal(result.subject, "Application for Data Analyst - Vikrant");
  assert.match(result.bodyText, /Hi Jane,/);
  assert.match(result.bodyText, /opening for:/);
  assert.match(result.bodyText, /- Data Analyst \(https:\/\/acme\.com\/jobs\/1\)/);
  assert.match(result.bodyText, /the role\./);
  assert.doesNotMatch(result.bodyText, /\{\{/);
});

test("renderDraft with 3 roles: plural, '+2 more' summary, roles_block has all lines", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: "John Smith",
    company: "Beta Corp",
    roles: [
      { title: "Data Analyst", jobUrl: "https://beta.com/1" },
      { title: "BI Engineer", jobUrl: "https://beta.com/2" },
      { title: "Analytics Lead", jobUrl: "https://beta.com/3" },
    ],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });

  assert.equal(result.subject, "Application for Data Analyst and 2 more - Vikrant");
  assert.match(result.bodyText, /openings for:/);
  assert.match(result.bodyText, /- Data Analyst \(https:\/\/beta\.com\/1\)/);
  assert.match(result.bodyText, /- BI Engineer \(https:\/\/beta\.com\/2\)/);
  assert.match(result.bodyText, /- Analytics Lead \(https:\/\/beta\.com\/3\)/);
  assert.match(result.bodyText, /the roles\./);
});

test("renderDraft falls back to 'there' when contact name is null", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: null,
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });
  assert.match(result.bodyText, /Hi there,/);
});

test("renderDraft uses only the first whitespace token of the contact name", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: "Priya Sharma",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });
  assert.match(result.bodyText, /Hi Priya,/);
});

test("renderDraft: profile_pitch absent renders as empty string, reads naturally with next sentence", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: "Jane",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });
  assert.match(result.bodyText, /\n\nMy resume is attached/);
});

test("renderDraft: profile_pitch present is followed by two newlines before the next sentence", () => {
  const result = renderDraft({
    template: baseTemplate,
    contactName: "Jane",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: "I've spent 4 years building analytics pipelines.",
    senderLinks: [],
  });
  assert.match(result.bodyText, /I've spent 4 years building analytics pipelines\.\n\nMy resume is attached/);
});

test("renderDraft: sender_links joined with ' | ', empty string when none", () => {
  const withLinks = renderDraft({
    template: baseTemplate,
    contactName: "Jane",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: ["https://linkedin.com/in/x", "https://github.com/x"],
  });
  assert.match(withLinks.bodyText, /https:\/\/linkedin\.com\/in\/x \| https:\/\/github\.com\/x/);

  const withoutLinks = renderDraft({
    template: baseTemplate,
    contactName: "Jane",
    company: "Acme",
    roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
    senderName: "Vikrant",
    profilePitch: null,
    senderLinks: [],
  });
  assert.match(withoutLinks.bodyText, /Vikrant\n\n?$/);
});

test("renderDraft throws when the template contains an unknown placeholder", () => {
  const badTemplate = {
    subject: "Subject with {{unknown_placeholder}}",
    body: "Body {{company}}",
  };
  assert.throws(
    () =>
      renderDraft({
        template: badTemplate,
        contactName: "Jane",
        company: "Acme",
        roles: [{ title: "Data Analyst", jobUrl: "https://acme.com/1" }],
        senderName: "Vikrant",
        profilePitch: null,
        senderLinks: [],
      }),
    /unknown_placeholder/,
  );
});
