import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt, envBool } from "../env.js";

const VAR = "JOB_HUNTER_TEST_ENV_INT";
const BOOL_VAR = "JOB_HUNTER_TEST_ENV_BOOL";

function withBool(value: string, run: () => void): void {
  process.env[BOOL_VAR] = value;
  try {
    run();
  } finally {
    delete process.env[BOOL_VAR];
  }
}

test("envInt returns the fallback when the env var is absent", () => {
  delete process.env[VAR];
  assert.equal(envInt(VAR, 42), 42);
});

test("envInt returns the fallback when the env var is an empty string", () => {
  process.env[VAR] = "";
  try {
    assert.equal(envInt(VAR, 42), 42);
  } finally {
    delete process.env[VAR];
  }
});

test("envInt returns the fallback when the env var is garbage", () => {
  process.env[VAR] = "not-a-number";
  try {
    assert.equal(envInt(VAR, 42), 42);
  } finally {
    delete process.env[VAR];
  }
});

test('envInt returns the fallback when the env var is "0"', () => {
  process.env[VAR] = "0";
  try {
    assert.equal(envInt(VAR, 42), 42);
  } finally {
    delete process.env[VAR];
  }
});

test("envInt returns the parsed value for a valid positive integer string", () => {
  process.env[VAR] = "1234";
  try {
    assert.equal(envInt(VAR, 42), 1234);
  } finally {
    delete process.env[VAR];
  }
});

test("envBool returns the fallback when the env var is absent", () => {
  delete process.env[BOOL_VAR];
  assert.equal(envBool(BOOL_VAR, true), true);
  assert.equal(envBool(BOOL_VAR, false), false);
});

test("envBool returns the fallback when the env var is an empty string", () => {
  withBool("", () => {
    assert.equal(envBool(BOOL_VAR, true), true);
  });
});

test('envBool parses "true" and "false"', () => {
  withBool("true", () => assert.equal(envBool(BOOL_VAR, false), true));
  withBool("false", () => assert.equal(envBool(BOOL_VAR, true), false));
});

test("envBool is case-insensitive and trims surrounding whitespace", () => {
  withBool("  TRUE  ", () => assert.equal(envBool(BOOL_VAR, false), true));
  withBool("False", () => assert.equal(envBool(BOOL_VAR, true), false));
});

// Anything that is not exactly true/false falls back. For LOCAL (fallback true)
// that means a typo like LOCAL=1 keeps the run on the local model rather than
// silently switching to the paid provider.
test("envBool returns the fallback for values that are not true/false", () => {
  for (const raw of ["1", "0", "yes", "no", "on", "off", "not-a-bool"]) {
    withBool(raw, () => {
      assert.equal(envBool(BOOL_VAR, true), true, `expected fallback for '${raw}'`);
      assert.equal(envBool(BOOL_VAR, false), false, `expected fallback for '${raw}'`);
    });
  }
});
