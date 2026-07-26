// src/ats/test-helpers.ts - shared fetch-stubbing for adapter tests.
// Not imported by production code; lives beside the tests it serves.
import type { TestContext } from "node:test";
import type { AdapterCompany } from "../types.js";

/** Replace globalThis.fetch for the duration of one test; restores via t.after. */
export function stubFetch(t: TestContext, handler: typeof globalThis.fetch): void {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = real;
  });
}

/** Serve canned responses in order; throws on any extra call (promoted from
 *  zappyhire.test.ts's stubFetchSeq). Each entry is a thunk so Response bodies
 *  are fresh per call. */
export function fetchSequence(...responses: Array<() => Response>): typeof globalThis.fetch {
  let i = 0;
  return () => {
    const next = responses[i];
    i++;
    if (!next) return Promise.reject(new Error(`fetchSequence: unexpected fetch call #${i}`));
    return Promise.resolve(next());
  };
}

// Generic (not JsonValue) so callers can pass mock objects built from real
// domain types (e.g. NewGenJob) whose zod-derived optional fields are typed
// `T | undefined` — JSON.stringify serializes them identically to a plain
// JsonValue (undefined properties are dropped), so the looser type costs
// nothing at runtime.
export function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html" } });
}

export function mkAdapterCompany(
  base: Pick<AdapterCompany, "provider" | "slug" | "name" | "careersUrl">,
  overrides: Partial<AdapterCompany> = {},
): AdapterCompany {
  return { tenantUrl: null, apiMeta: null, ...base, ...overrides };
}
