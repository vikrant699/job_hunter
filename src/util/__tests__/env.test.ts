import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt } from "../env.js";

const VAR = "JOB_HUNTER_TEST_ENV_INT";

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
