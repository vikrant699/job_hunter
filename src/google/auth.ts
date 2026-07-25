// src/google/auth.ts
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { config } from "../config.js";
import { writeFileAtomic } from "../util/fs.js";

const TokenFileSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string(),
  expiry: z.number(),
});
type TokenFile = z.infer<typeof TokenFileSchema>;

const RefreshResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

/** Refresh this many ms before actual expiry so a call never races an expired token. */
const EXPIRY_GUARD_MS = 60_000;

/**
 * Thrown when a profile's Google refresh token is missing, revoked, or expired
 * (the consent screen is in Testing mode, so this happens ~weekly). The message
 * always embeds the exact fix command so a human hitting this in a log doesn't
 * have to go spelunking for the right invocation.
 */
export class GoogleAuthExpiredError extends Error {
  constructor(profileId: string, reason: string) {
    super(
      `Google auth for profile "${profileId}" is expired or invalid (${reason}). ` +
        `Re-consent with: npm run google-auth -- --profile ${profileId}`,
    );
    this.name = "GoogleAuthExpiredError";
  }
}

export interface GoogleAuthDeps {
  fetchFn: typeof fetch;
  tokenPath: string;
  readFile: (path: string) => string;
  existsSync: (path: string) => boolean;
  writeFileAtomic: (path: string, contents: string) => void;
  now: () => number;
}

function defaultDeps(profileId: string): GoogleAuthDeps {
  return {
    fetchFn: fetch,
    tokenPath: config.google.tokenPathFor(profileId),
    readFile: (path: string) => readFileSync(path, "utf-8"),
    existsSync,
    writeFileAtomic,
    now: () => Date.now(),
  };
}

function requireClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || clientId.trim() === "") {
    throw new Error("GOOGLE_CLIENT_ID is not set in .env — see scripts/google-auth.ts for setup.");
  }
  if (!clientSecret || clientSecret.trim() === "") {
    throw new Error("GOOGLE_CLIENT_SECRET is not set in .env — see scripts/google-auth.ts for setup.");
  }
  return { clientId, clientSecret };
}

function readTokenFile(profileId: string, deps: GoogleAuthDeps): TokenFile {
  if (!deps.existsSync(deps.tokenPath)) {
    throw new GoogleAuthExpiredError(profileId, `no token file at ${deps.tokenPath}`);
  }
  let raw: string;
  try {
    raw = deps.readFile(deps.tokenPath);
  } catch {
    throw new GoogleAuthExpiredError(profileId, `could not read token file at ${deps.tokenPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleAuthExpiredError(profileId, `token file at ${deps.tokenPath} is not valid JSON`);
  }
  const result = TokenFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new GoogleAuthExpiredError(profileId, `token file at ${deps.tokenPath} failed validation`);
  }
  return result.data;
}

async function refresh(profileId: string, token: TokenFile, deps: GoogleAuthDeps): Promise<TokenFile> {
  const { clientId, clientSecret } = requireClientCreds();
  const res = await deps.fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    if (res.status === 400 || res.status === 401 || bodyText.includes("invalid_grant")) {
      throw new GoogleAuthExpiredError(profileId, `refresh failed: HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    throw new Error(`Google token refresh HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  const parsed = RefreshResponseSchema.parse(await res.json());
  const updated: TokenFile = {
    refresh_token: token.refresh_token,
    access_token: parsed.access_token,
    expiry: deps.now() + parsed.expires_in * 1000,
  };
  deps.writeFileAtomic(deps.tokenPath, JSON.stringify(updated, null, 2));
  return updated;
}

// In-memory cache so repeated calls within a run don't re-read the token file.
// Keyed by profileId; cleared only via __resetTokenCacheForTests (tests) — a
// live process is expected to hold one cache for its lifetime.
const tokenCache = new Map<string, TokenFile>();

/** Test-only: clear the in-memory token cache between test cases. */
export function __resetTokenCacheForTests(): void {
  tokenCache.clear();
}

/**
 * Returns a valid access token for the given profile, refreshing it first if
 * it is at or near expiry. Reads+caches the token file in memory so repeated
 * calls within a process don't re-read disk. Throws GoogleAuthExpiredError if
 * the token file is missing/invalid or the refresh token has been revoked.
 */
export async function getAccessToken(profileId: string, deps: GoogleAuthDeps = defaultDeps(profileId)): Promise<string> {
  let token = tokenCache.get(profileId);
  if (!token) {
    token = readTokenFile(profileId, deps);
    tokenCache.set(profileId, token);
  }
  if (deps.now() >= token.expiry - EXPIRY_GUARD_MS) {
    token = await refresh(profileId, token, deps);
    tokenCache.set(profileId, token);
  }
  return token.access_token;
}

/**
 * Force one refresh round-trip regardless of expiry, to validate the
 * refresh_token itself rather than trusting a cached/unexpired access token.
 * Mirrors assertOllamaAvailable's fail-fast role: call this before a
 * production tick so a revoked/expired refresh token surfaces immediately
 * with an actionable fix command, instead of failing deep inside a batch of
 * draft creation calls.
 */
export async function assertGoogleTokenValid(profileId: string, deps: GoogleAuthDeps = defaultDeps(profileId)): Promise<void> {
  const token = tokenCache.get(profileId) ?? readTokenFile(profileId, deps);
  const refreshed = await refresh(profileId, token, deps);
  tokenCache.set(profileId, refreshed);
}
