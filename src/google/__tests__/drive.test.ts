import { test } from "node:test";
import assert from "node:assert/strict";
import { findDbFile } from "../drive.js";

const NOW = 1_770_000_000_000;

/** A token file the auth module accepts without touching the network. */
function authStub(): {
  fetchFn: typeof fetch;
  tokenPath: string;
  readFile: () => string;
  existsSync: () => boolean;
  writeFileAtomic: () => void;
  now: () => number;
} {
  return {
    fetchFn: async () => new Response("{}", { status: 200 }),
    tokenPath: "unused",
    readFile: () =>
      JSON.stringify({ refresh_token: "r", access_token: "a", expiry: NOW + 3_600_000 }),
    existsSync: () => true,
    writeFileAtomic: () => undefined,
    now: () => NOW,
  };
}

/** Verbatim shape of the 403 Google returns when the API is off for the project. */
const API_DISABLED_BODY = JSON.stringify({
  error: {
    code: 403,
    message:
      "Google Drive API has not been used in project 678726042524 before or it is disabled. " +
      "Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=678726042524 " +
      "then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    status: "PERMISSION_DENIED",
  },
});

test("an API-disabled 403 explains the one-time console step and names the project", async () => {
  await assert.rejects(
    findDbFile("vikrant", {
      fetchFn: async () => new Response(API_DISABLED_BODY, { status: 403 }),
      authDeps: authStub(),
    }),
    (err: Error) => {
      assert.match(err.message, /not enabled/);
      assert.match(err.message, /678726042524/, "names the project so the link is usable");
      assert.match(err.message, /console\.cloud\.google\.com/);
      // Easy to mistake for the permission error it is not.
      assert.match(err.message, /separate from consent/);
      return true;
    },
  );
});

test("an insufficient-scope 403 is left as the plain error it is", async () => {
  const body = JSON.stringify({
    error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" },
  });
  await assert.rejects(
    findDbFile("vikrant", {
      fetchFn: async () => new Response(body, { status: 403 }),
      authDeps: authStub(),
    }),
    (err: Error) => {
      assert.match(err.message, /insufficient authentication scopes/);
      assert.doesNotMatch(err.message, /not enabled/);
      return true;
    },
  );
});
