import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBreakdown, buildProgressEmbed, type ProgressContext } from "../progress.js";
import type { RunContext } from "../../pipeline/index.js";

function ctxWith(
  bucketProgress: Map<string, { total: number; scanned: number }>,
  over: Partial<Pick<RunContext, "postingsSeen" | "postingsGreen" | "postingsYellow">> = {},
): ProgressContext {
  const stats: RunContext = {
    companiesScanned: 0,
    postingsSeen: 0,
    postingsNew: 0,
    postingsGreen: 0,
    postingsYellow: 0,
    postingsTitleDenied: 0,
    postingsDuplicated: 0,
    jdFetchFailed: 0,
    errors: [],
    failedCompanies: [],
    transportRetried: 0,
    transportDeferred: [],
    transportRecovered: 0,
    priorNotifyKeys: new Set(),
    seenNotifyKeys: new Set(),
    profileId: "vikrant",
    bucketProgress,
    ...over,
  };
  return { stats, startedAt: 0, profileId: "vikrant" };
}

const fieldVal = (embed: ReturnType<typeof buildProgressEmbed>, name: string): string | undefined =>
  embed.fields.find((f) => f.name === name)?.value;

test("buildBreakdown lists buckets biggest-first, ✓ when a bucket is drained", () => {
  const bp = new Map([
    ["greenhouse", { total: 200, scanned: 200 }],
    ["llm-scrape", { total: 520, scanned: 88 }],
    ["playwright-llm-scrape", { total: 140, scanned: 19 }],
  ]);
  assert.equal(buildBreakdown(bp), "llm-scrape 88/520 · greenhouse 200/200 ✓ · playwright-llm-scrape 19/140");
});

test("buildBreakdown is em-dash when there are no buckets", () => {
  assert.equal(buildBreakdown(new Map()), "—");
});

test("buildProgressEmbed sums buckets, computes pct, and formats counts/elapsed", () => {
  const bp = new Map([
    ["greenhouse", { total: 200, scanned: 200 }],
    ["llm-scrape", { total: 520, scanned: 88 }],
    ["playwright-llm-scrape", { total: 140, scanned: 19 }],
  ]);
  const ctx = ctxWith(bp, { postingsSeen: 1234, postingsGreen: 12, postingsYellow: 5 });
  // 3h 25m after start.
  const embed = buildProgressEmbed(ctx, (3 * 60 + 25) * 60_000);

  assert.equal(fieldVal(embed, "Profile"), "vikrant");
  assert.equal(fieldVal(embed, "Companies"), "307 / 860 (36%)"); // 307/860 = 35.7% -> 36
  assert.equal(fieldVal(embed, "Elapsed"), "3h 25m");
  assert.equal(fieldVal(embed, "Jobs seen"), "1234");
  assert.equal(fieldVal(embed, "Jobs relevant"), "17 (12g / 5y)");
  assert.equal(
    fieldVal(embed, "By strategy"),
    "llm-scrape 88/520 · greenhouse 200/200 ✓ · playwright-llm-scrape 19/140",
  );
});

test("buildProgressEmbed handles the empty/zero state without dividing by zero", () => {
  const embed = buildProgressEmbed(ctxWith(new Map()), 25 * 60_000);
  assert.equal(fieldVal(embed, "Companies"), "0 / 0 (0%)");
  assert.equal(fieldVal(embed, "Elapsed"), "25m");
  assert.equal(fieldVal(embed, "By strategy"), "—");
});
