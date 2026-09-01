import { test } from "node:test";
import assert from "node:assert/strict";
import { instahyreCredsForProfile, runInstahyreAutoApply } from "../autoApply.js";

test("instahyreCredsForProfile returns creds when both vars are set for the uppercased profile id", () => {
  const env = { INSTAHYRE_EMAIL_VIKRANT: "a@b.com", INSTAHYRE_PASSWORD_VIKRANT: "secret" };
  const creds = instahyreCredsForProfile("vikrant", env);
  assert.deepEqual(creds, { email: "a@b.com", password: "secret" });
});

test("instahyreCredsForProfile maps a mixed-case profile id to the uppercased var names", () => {
  const env = { INSTAHYRE_EMAIL_DIVYA: "d@x.com", INSTAHYRE_PASSWORD_DIVYA: "pw" };
  const creds = instahyreCredsForProfile("Divya", env);
  assert.deepEqual(creds, { email: "d@x.com", password: "pw" });
});

test("instahyreCredsForProfile returns null when the email var is missing", () => {
  const env = { INSTAHYRE_PASSWORD_VIKRANT: "secret" };
  assert.equal(instahyreCredsForProfile("vikrant", env), null);
});

test("instahyreCredsForProfile returns null when the password var is missing", () => {
  const env = { INSTAHYRE_EMAIL_VIKRANT: "a@b.com" };
  assert.equal(instahyreCredsForProfile("vikrant", env), null);
});

test("instahyreCredsForProfile returns null when either var is set but empty", () => {
  const env = { INSTAHYRE_EMAIL_VIKRANT: "", INSTAHYRE_PASSWORD_VIKRANT: "secret" };
  assert.equal(instahyreCredsForProfile("vikrant", env), null);
});

test("instahyreCredsForProfile returns null when neither var is set", () => {
  assert.equal(instahyreCredsForProfile("vikrant", {}), null);
});

test("runInstahyreAutoApply skips fast with no browser launch when the profile has no credentials", async () => {
  const originalEmail = process.env.INSTAHYRE_EMAIL_NOSUCHPROFILE;
  const originalPassword = process.env.INSTAHYRE_PASSWORD_NOSUCHPROFILE;
  delete process.env.INSTAHYRE_EMAIL_NOSUCHPROFILE;
  delete process.env.INSTAHYRE_PASSWORD_NOSUCHPROFILE;
  try {
    const start = Date.now();
    const result = await runInstahyreAutoApply("nosuchprofile");
    const elapsedMs = Date.now() - start;
    assert.deepEqual(result, {
      applied: 0,
      confirmed: 0,
      skippedReason: "no credentials for profile",
      error: null,
      durationMs: result.durationMs,
    });
    // Fast: no browser launch, no network wait.
    assert.ok(elapsedMs < 2000, `expected a fast skip, took ${elapsedMs}ms`);
  } finally {
    if (originalEmail !== undefined) process.env.INSTAHYRE_EMAIL_NOSUCHPROFILE = originalEmail;
    if (originalPassword !== undefined) process.env.INSTAHYRE_PASSWORD_NOSUCHPROFILE = originalPassword;
  }
});
