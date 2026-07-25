// src/ats/test-helpers.ts - shared fetch-stubbing for adapter tests.
// Not imported by production code; lives beside the tests it serves.
import type { TestContext } from "node:test";
import type { AdapterCompany } from "../types.js";
import type { JsonValue } from "../util/json.js";

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

export function jsonResponse(body: JsonValue, status = 200): Response {
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
