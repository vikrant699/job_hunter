// src/google/rest.ts
import { z } from "zod";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { getAccessToken, type GoogleAuthDeps } from "./auth.js";

/** How long to back off before the single retry on 429/5xx. */
const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface RestDeps {
  fetchFn?: typeof fetch;
  /** Injected auth deps, forwarded to getAccessToken (tests only — production uses the default). */
  authDeps?: GoogleAuthDeps;
  /** Override the 429/5xx backoff delay (tests use a near-zero value). */
  retryDelayMs?: number;
}

/**
 * Authorized fetch-json wrapper shared by the Sheets and Gmail clients:
 * attaches the bearer token for `profileId`, retries once with a short
 * backoff (mirrors src/discord/webhook.ts's retry tone, kept simpler since
 * these are low-volume, interactive-adjacent calls), and returns the raw
 * parsed JSON body for the caller to zod-validate. Throws a plain Error with
 * status + body snippet on a non-retryable or still-failing response.
 *
 * Retry policy: 429 retries for every method (a rate-limited request was
 * rejected before processing), but 5xx retries only idempotent methods —
 * a POST (draft create, row append) may have been processed before the
 * error response, and replaying it would duplicate the draft/row.
 */
export async function googleFetchJson(
  profileId: string,
  url: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
  deps: RestDeps = {},
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const accessToken = await getAccessToken(profileId, deps.authDeps);

  const method = init.method ?? "GET";
  const idempotent = method !== "POST";
  for (let attempt = 0; attempt <= 1; attempt++) {
    const res = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if ((res.status === 429 || (idempotent && res.status >= 500)) && attempt === 0) {
      logger.warn({ url, status: res.status, attempt }, "Google API transient failure; retrying once");
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error("Google API retry exhausted");
}

export function requireSpreadsheetId(): string {
  const id = process.env.GOOGLE_SPREADSHEET_ID;
  if (!id || id.trim() === "") {
    throw new Error("GOOGLE_SPREADSHEET_ID is not set in .env.");
  }
  return id;
}

export const CellsRowSchema = z.array(z.coerce.string());
export const CellsSchema = z.array(CellsRowSchema);
