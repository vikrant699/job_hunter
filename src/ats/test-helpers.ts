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

/** htmlResponse that also reports where a redirect chain landed. The Response
 *  constructor leaves `url` empty — only a real fetch fills it — so adapters that
 *  key on atsFetchHtml's `finalUrl` (e.g. jazzhr's off-host tenant check) are
 *  otherwise untestable without a live request. An own property shadows the
 *  prototype's read-only getter. */
export function htmlResponseFrom(finalUrl: string, html: string, status = 200): Response {
  const res = htmlResponse(html, status);
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

/** Indexed access for test fixtures: throws with a clear message instead of `!`. */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`test fixture: expected element at index ${i} (length ${arr.length})`);
  return v;
}

export function mkAdapterCompany(
  base: Pick<AdapterCompany, "provider" | "slug" | "name" | "careersUrl">,
  overrides: Partial<AdapterCompany> = {},
): AdapterCompany {
  return { tenantUrl: null, apiMeta: null, ...base, ...overrides };
}
