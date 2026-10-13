import { z } from "zod";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { getAccessToken } from "./auth.js";
import type { GoogleAuthDeps } from "./auth.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";

const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface RestDeps {
  fetchFn?: typeof fetch;
  authDeps?: GoogleAuthDeps;
  retryDelayMs?: number;
}

// 429 retries for every method; 5xx only for idempotent ones, since replaying a POST would duplicate the draft/row.
export async function googleFetchJson(
  profileId: string,
  url: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: JsonValue } = {},
  deps: RestDeps = {},
): Promise<JsonValue> {
  const fetchFn = deps.fetchFn ?? fetch;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const accessToken = await getAccessToken(profileId, deps.authDeps);

  const method = init.method ?? "GET";
  const idempotent = method !== "POST";
  for (let attempt = 0; attempt <= 1; attempt++) {
    await awaitNetwork();
    let res: Response;
    try {
      res = await fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      reportNetworkFailure();
      throw err;
    }
    reportNetworkSuccess();

    if ((res.status === 429 || (idempotent && res.status >= 500)) && attempt === 0) {
      logger.warn({ url, status: res.status, attempt }, "Google API transient failure; retrying once");
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return JsonValueSchema.parse(await res.json());
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
