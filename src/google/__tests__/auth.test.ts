import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { getAccessToken, assertGoogleTokenValid, GoogleAuthExpiredError, __resetTokenCacheForTests } from "../auth.js";

const FakeFileSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string(),
  expiry: z.number(),
});

const ENV_BACKUP = { ...process.env };

function setEnv(): void {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ENV_BACKUP);
}

type FakeFile = z.infer<typeof FakeFileSchema>;

function makeFakeFs(initial: FakeFile | null): {
  files: Map<string, FakeFile>;
  readFile: (path: string) => string;
  existsSync: (path: string) => boolean;
  writeFileAtomic: (path: string, contents: string) => void;
} {
  const files = new Map<string, FakeFile>();
  const path = "data/google-token-testprofile.json";
  if (initial) files.set(path, initial);
  return {
    files,
    readFile: (p: string) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return JSON.stringify(f);
    },
    existsSync: (p: string) => files.has(p),
    writeFileAtomic: (p: string, contents: string) => {
      files.set(p, FakeFileSchema.parse(JSON.parse(contents)));
    },
  };
}

beforeEach(() => {
  restoreEnv();
  setEnv();
  __resetTokenCacheForTests();
});

test("getAccessToken: fresh token does not trigger a refresh", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-fresh",
    expiry: Date.now() + 60 * 60 * 1000,
  });
  let fetchCalled = false;
  const fetchFn: typeof fetch = async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  };
  const token = await getAccessToken("testprofile", {
    fetchFn,
    tokenPath: "data/google-token-testprofile.json",
    readFile: fake.readFile,
    existsSync: fake.existsSync,
    writeFileAtomic: fake.writeFileAtomic,
    now: () => Date.now(),
  });
  assert.equal(token, "at-fresh");
  assert.equal(fetchCalled, false);
});

test("getAccessToken: near-expiry token refreshes and rewrites the file", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-old",
    expiry: Date.now() + 10_000, // within the 60s guard window
  });
  let capturedParams: URLSearchParams | undefined;
  const fetchFn: typeof fetch = async (_url, init) => {
    capturedParams = init?.body instanceof URLSearchParams ? init.body : undefined;
    return new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 });
  };
  const token = await getAccessToken("testprofile", {
    fetchFn,
    tokenPath: "data/google-token-testprofile.json",
    readFile: fake.readFile,
    existsSync: fake.existsSync,
    writeFileAtomic: fake.writeFileAtomic,
    now: () => Date.now(),
  });
  assert.equal(token, "at-new");
  assert.ok(capturedParams);
  const params = capturedParams;
  assert.equal(params.get("refresh_token"), "rt-1");
  assert.equal(params.get("client_id"), "test-client-id");
  assert.equal(params.get("client_secret"), "test-client-secret");
  assert.equal(params.get("grant_type"), "refresh_token");
  const rewritten = fake.files.get("data/google-token-testprofile.json");
  assert.ok(rewritten);
  assert.equal(rewritten.access_token, "at-new");
  assert.equal(rewritten.refresh_token, "rt-1");
  assert.ok(rewritten.expiry > Date.now());
});

test("getAccessToken: caches in-memory so a second call does not re-read the file", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-fresh",
    expiry: Date.now() + 60 * 60 * 1000,
  });
  let readCount = 0;
  const readFile = (p: string): string => {
    readCount++;
    return fake.readFile(p);
  };
  const deps = {
    fetchFn: (async () => {
      throw new Error("should not be called");
    }) satisfies typeof fetch,
    tokenPath: "data/google-token-testprofile.json",
    readFile,
    existsSync: fake.existsSync,
    writeFileAtomic: fake.writeFileAtomic,
    now: () => Date.now(),
  };
  await getAccessToken("testprofile", deps);
  await getAccessToken("testprofile", deps);
  assert.equal(readCount, 1);
});

test("getAccessToken: invalid_grant from refresh -> GoogleAuthExpiredError with fix command", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-dead",
    access_token: "at-old",
    expiry: Date.now() - 1000,
  });
  const fetchFn: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
      status: 400,
    });
  await assert.rejects(
    getAccessToken("testprofile", {
      fetchFn,
      tokenPath: "data/google-token-testprofile.json",
      readFile: fake.readFile,
      existsSync: fake.existsSync,
      writeFileAtomic: fake.writeFileAtomic,
      now: () => Date.now(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    (err: unknown) => {
      assert.ok(err instanceof GoogleAuthExpiredError);
      assert.match(err.message, /npm run google-auth -- --profile testprofile/);
      return true;
    },
  );
});

test("getAccessToken: missing token file -> GoogleAuthExpiredError", async () => {
  const fake = makeFakeFs(null);
  await assert.rejects(
    getAccessToken("testprofile", {
      fetchFn: (async () => {
        throw new Error("should not be called");
      }) satisfies typeof fetch,
      tokenPath: "data/google-token-testprofile.json",
      readFile: fake.readFile,
      existsSync: fake.existsSync,
      writeFileAtomic: fake.writeFileAtomic,
      now: () => Date.now(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    (err: unknown) => {
      assert.ok(err instanceof GoogleAuthExpiredError);
      assert.match(err.message, /npm run google-auth -- --profile testprofile/);
      return true;
    },
  );
});

test("getAccessToken: other non-OK refresh status -> plain Error with status and snippet", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-old",
    expiry: Date.now() - 1000,
  });
  const fetchFn: typeof fetch = async () => new Response("server exploded", { status: 500 });
  await assert.rejects(
    getAccessToken("testprofile", {
      fetchFn,
      tokenPath: "data/google-token-testprofile.json",
      readFile: fake.readFile,
      existsSync: fake.existsSync,
      writeFileAtomic: fake.writeFileAtomic,
      now: () => Date.now(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof GoogleAuthExpiredError));
      assert.match(err.message, /500/);
      assert.match(err.message, /server exploded/);
      return true;
    },
  );
});

test("assertGoogleTokenValid: forces a refresh even when the token is fresh", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-fresh",
    expiry: Date.now() + 60 * 60 * 1000,
  });
  let fetchCalled = false;
  const fetchFn: typeof fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ access_token: "at-verified", expires_in: 3600 }), { status: 200 });
  };
  await assertGoogleTokenValid("testprofile", {
    fetchFn,
    tokenPath: "data/google-token-testprofile.json",
    readFile: fake.readFile,
    existsSync: fake.existsSync,
    writeFileAtomic: fake.writeFileAtomic,
    now: () => Date.now(),
  });
  assert.equal(fetchCalled, true);
});

test("assertGoogleTokenValid: invalid_grant -> GoogleAuthExpiredError", async () => {
  const fake = makeFakeFs({
    refresh_token: "rt-dead",
    access_token: "at-fresh",
    expiry: Date.now() + 60 * 60 * 1000,
  });
  const fetchFn: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  await assert.rejects(
    assertGoogleTokenValid("testprofile", {
      fetchFn,
      tokenPath: "data/google-token-testprofile.json",
      readFile: fake.readFile,
      existsSync: fake.existsSync,
      writeFileAtomic: fake.writeFileAtomic,
      now: () => Date.now(),
    }),
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    (err: unknown) => {
      assert.ok(err instanceof GoogleAuthExpiredError);
      return true;
    },
  );
});

test("getAccessToken: missing client id/secret env gives a clear error", async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  const fake = makeFakeFs({
    refresh_token: "rt-1",
    access_token: "at-old",
    expiry: Date.now() - 1000,
  });
  await assert.rejects(
    getAccessToken("testprofile", {
      fetchFn: (async () => new Response("{}", { status: 200 })) satisfies typeof fetch,
      tokenPath: "data/google-token-testprofile.json",
      readFile: fake.readFile,
      existsSync: fake.existsSync,
      writeFileAtomic: fake.writeFileAtomic,
      now: () => Date.now(),
    }),
    /GOOGLE_CLIENT_ID/,
  );
});
