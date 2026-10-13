import type { TestContext } from "node:test";
import type { AdapterCompany } from "../../types.js";
import type { JsonValue } from "../../util/json.js";
import { JsonValueSchema } from "../../util/json.js";

export function stubFetch(t: TestContext, handler: typeof globalThis.fetch): void {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = real;
  });
}

export function fetchSequence(...responses: Array<() => Response>): typeof globalThis.fetch {
  let i = 0;
  return () => {
    const next = responses[i];
    i++;
    if (!next) return Promise.reject(new Error(`fetchSequence: unexpected fetch call #${i}`));
    return Promise.resolve(next());
  };
}

// Generic (not JsonValue) so callers can pass mock domain objects with `T | undefined` optional fields; JSON.stringify drops undefined props anyway.
export function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html" } });
}

/** htmlResponse that also reports where a redirect chain landed, since the Response constructor otherwise leaves `url` empty. */
export function htmlResponseFrom(finalUrl: string, html: string, status = 200): Response {
  const res = htmlResponse(html, status);
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

export const CHALLENGE_PAGE_HTML =
  `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>` +
  `<body><h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: 8f2a1c</p></body></html>`;

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

export function asJson<T>(value: T): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}
