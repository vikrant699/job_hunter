import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusEmbed } from "./status.js";
import type { ProductionTickOutcome } from "../pipeline/index.js";

function mkStats(overrides: Partial<ProductionTickOutcome["stats"]> = {}): ProductionTickOutcome["stats"] {
  return {
    companiesScanned: 100,
    postingsSeen: 500,
    postingsNew: 42,
    postingsGreen: 5,
    postingsYellow: 8,
    postingsTitleDenied: 60,
    postingsDuplicated: 3,
    jdFetchFailed: 2,
    errors: [],
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
  });
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName["Outreach error"], "Google auth expired");
  assert.equal(byName["Drafts created"], undefined);
  assert.equal(byName["Undrafted"], undefined);
});
