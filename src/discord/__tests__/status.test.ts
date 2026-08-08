import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusEmbed, buildIssueList } from "../status.js";
import type { ProductionTickOutcome } from "../../pipeline/index.js";

function mkStats(overrides: Partial<ProductionTickOutcome["stats"]> = {}): ProductionTickOutcome["stats"] {
  return {
    companiesScanned: 100,
    postingsSeen: 500,
    postingsNew: 42,
    postingsGreen: 5,
    postingsYellow: 8,
    postingsTitleDenied: 60,
    postingsYoeDenied: 0,
    postingsDuplicated: 3,
    jdFetchFailed: 2,
    transportRetried: 0,
    transportRecovered: 0,
    errors: [],
    failedCompanies: [],
    durationMs: 123_456,
    ...overrides,
  };
}

test("buildStatusEmbed includes the profile id in the title", () => {
  const embed = buildStatusEmbed({
    profileId: "vikrant",
    stats: mkStats(),
    outreach: { draftsCreated: 3, undrafted: 1, companiesMatched: 2 },
    outreachError: null,
    verify: null,
    registry: null,
  });
  assert.match(embed.title, /vikrant/);
  assert.match(embed.title, /run complete/);
});

test("buildStatusEmbed surfaces companies/postings/green/yellow/jdFetchFailed/errors fields", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats({ postingsGreen: 5, postingsYellow: 8, jdFetchFailed: 2, errors: ["oops"] }),
    outreach: { draftsCreated: 3, undrafted: 1, companiesMatched: 2 },
    outreachError: null,
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Companies scanned"], "100");
  assert.equal(byName["Postings seen"], "500");
  assert.equal(byName["New postings"], "42");
  assert.equal(byName["Green"], "5");
  assert.equal(byName["Yellow"], "8");
  assert.equal(byName["JD fetch failed"], "2");
  assert.equal(byName["Errors"], "1");
});

test("buildStatusEmbed surfaces drafts created / undrafted counts and a spreadsheet link", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: { draftsCreated: 7, undrafted: 4, companiesMatched: 5 },
    outreachError: null,
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Drafts created"], "7");
  assert.equal(byName["Undrafted"], "4");
  const spreadsheetField = embed.fields.find((f) => f.name === "Spreadsheet");
  assert.ok(spreadsheetField);
  assert.match(spreadsheetField.value, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
});

test("buildStatusEmbed shows an outreach-error field instead of drafts/undrafted when outreach failed", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: null,
    outreachError: "Google auth expired",
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Outreach error"], "Google auth expired");
  assert.equal(byName["Drafts created"], undefined);
  assert.equal(byName["Undrafted"], undefined);
});

test("buildStatusEmbed renders a compact Verify field when a verify result is present", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: null,
    outreachError: null,
    verify: { checkedDrafts: 3, sent: 1, discarded: 1, bounced: 1, verified: 2 },
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.match(byName["Verify"] ?? "", /checked 3/);
  assert.match(byName["Verify"] ?? "", /sent 1/);
  assert.match(byName["Verify"] ?? "", /discarded 1/);
  assert.match(byName["Verify"] ?? "", /bounced 1/);
  assert.match(byName["Verify"] ?? "", /verified 2/);
});

test("buildStatusEmbed omits the Verify field when verify is null", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: { draftsCreated: 1, undrafted: 0, companiesMatched: 1 },
    outreachError: null,
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Verify"], undefined);
});

test("buildStatusEmbed renders a Registry field with source and invalid-row count when present", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: null,
    outreachError: null,
    verify: null,
    registry: { source: "sheet", invalidRows: 2 },
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.match(byName["Registry"] ?? "", /sheet/);
  assert.match(byName["Registry"] ?? "", /2/);
});

test("buildStatusEmbed omits the Registry field when registry is null", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: null,
    outreachError: null,
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Registry"], undefined);
});

test("buildStatusEmbed marks the embed orange when the registry sync fell back to the cache", () => {
  const embed = buildStatusEmbed({
    profileId: "default",
    stats: mkStats(),
    outreach: { draftsCreated: 1, undrafted: 0, companiesMatched: 1 },
    outreachError: null,
    verify: null,
    registry: { source: "cache", invalidRows: 0 },
  });
  assert.equal(embed.color, 0xe67e22);
});

test("buildStatusEmbed lists companies with issues, grouped by reason", () => {
  const embed = buildStatusEmbed({
    profileId: "vikrant",
    stats: mkStats({
      failedCompanies: [
        { provider: "smartrecruiters", slug: "bosch", reason: "timeout" },
        { provider: "phenom", slug: "abb", reason: "timeout" },
        { provider: "lever", slug: "dream11", reason: "404" },
      ],
    }),
    outreach: null,
    outreachError: null,
    verify: null,
    registry: null,
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Boards with issues"], "3");
  const list = byName["Companies with issues (3)"] ?? "";
  assert.match(list, /timeout ×2/);
  assert.match(list, /bosch/);
  assert.match(list, /404 ×1/);
});

test("buildIssueList truncates a large group and reports the overflow", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    provider: "greenhouse",
    slug: `company-${i}`,
    reason: "timeout",
  }));
  const out = buildIssueList(many, 1000);
  assert.ok(out.length <= 1000);
  assert.match(out, /timeout ×200/);
  assert.match(out, /\(\+\d+\)/);
});
