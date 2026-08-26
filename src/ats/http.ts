// src/ats/http.ts
import type { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

/** Build a typed Error for a failed ATS HTTP call. Pure — unit tested. */
export function atsHttpError(provider: string, status: number, bodySnippet: string): Error {
  if (status === 404) return new Error(`${provider} 404`);
  return new Error(`${provider} HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
}

/** Run `fn` with an AbortSignal that times out the WHOLE call (headers + body). Exported for adapters
 *  whose fetch shape doesn't fit atsFetchJson/atsFetchText. */
export async function withAtsTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = config.fetch.timeoutMs,
): Promise<T> {
  return fn(AbortSignal.timeout(timeoutMs));
}

/** fetch() that throws `atsHttpError` on non-OK. Every atsFetch* helper funnels through here, which is
 *  why the connectivity gate (park while network is down, report the outcome) lives here too. */
async function fetchOk(url: string, init: RequestInit, provider: string): Promise<Response> {
  await awaitNetwork();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Not a verdict, just a request for an immediate probe — if the connection is fine, this host is simply refusing us.
    reportNetworkFailure();
    throw err;
  }
  // ANY response proves the connection works, including a 403 from a bot-blocker — that's about the board, not the network.
  reportNetworkSuccess();
  if (!res.ok) {
    const body = await res.text();
    // Scan the FULL body for a WAF/block-page signature before atsHttpError truncates to 200 chars
    // (CloudFront/Akamai markers land past that cut). An edge-challenge classifies as an infrastructure
    // fault: retried inline, deferred to end-of-run, never charged to the row.
    assertNotEdgeChallenge(provider, url, body);
    throw atsHttpError(provider, res.status, body);
  }
  return res;
}

/** Fetch JSON with the standard ATS timeout + UA. Sends a JSON body (and POST) when `body` is provided. */
export async function atsFetchJson(
  url: string,
  opts: { method?: "GET" | "POST"; body?: JsonValue; provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<JsonValue> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<JsonValue>(async (signal) => {
    const res = await fetchOk(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        // Some WAF-fronted boards (Jibe) 403 the bot UA — those pass a browser UA.
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Caller headers last so a provider-specific header (webbtree customurl) wins.
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal,
    }, provider);
    return JsonValueSchema.parse(await res.json());
  });
}

export interface ParseCtx { provider: string; slug: string; what?: string }

// Generic over the SCHEMA (not a bare `<T>`) so `z.infer<S>` resolves to the schema's true post-transform
// output type, not the pre-transform shape TS would otherwise unify T against. The explicit `<unknown>`
// bound keeps `parsed.data` typed as `unknown` instead of `any` (a bare `z.ZodType` bound defaults to
// `any` and trips no-unsafe-return).

/** safeParse + warn-log + throw. The word "schema" must stay in the message — scheduler.classifyFetchError tags on it. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- the `<unknown>` bound keeps `parsed.data` as `unknown` rather than `any`
export function parseOrThrow<S extends z.ZodType<unknown>>(schema: S, raw: JsonValue, ctx: ParseCtx): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "list";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    throw new Error(`${ctx.provider} ${what} response failed schema for ${ctx.slug}`);
  }
  return parsed.data;
}

/** safeParse + warn-log + null, for detail fetches that degrade to "" instead of failing the company. */
// Same `<unknown>`-bound rationale as parseOrThrow above.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- the `<unknown>` bound keeps `parsed.data` as `unknown` rather than `any`
export function parseOrNull<S extends z.ZodType<unknown>>(schema: S, raw: JsonValue, ctx: ParseCtx): z.infer<S> | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "detail";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    return null;
  }
  return parsed.data;
}

/** POST form-urlencoded, parse the response as JSON. For ATSes (e.g. RippleHire) that content-negotiate
 *  on Accept (default XML, JSON if asked). Same timeout/UA/error semantics as atsFetchJson. */
export async function atsFetchFormJson(
  url: string,
  form: Record<string, string>,
  opts: { provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<JsonValue> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<JsonValue>(async (signal) => {
    const res = await fetchOk(url, {
      method: "POST",
      headers: {
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        // Caller headers last so a provider-specific header wins (same ordering convention as atsFetchJson).
        ...(opts.headers ?? {}),
      },
      body: new URLSearchParams(form).toString(),
      signal,
    }, provider);
    return JsonValueSchema.parse(await res.json());
  });
}

/** Like atsFetchJson but multipart/form-data POST with extra headers. Needed for ATSes (Ceipal) that
 *  require a Referer header and refuse a JSON body; userAgent override for stacks (Zwayam) that reject the bot UA. */
export async function atsFetchJsonMultipart(
  url: string,
  opts: { fields: Record<string, string>; headers?: Record<string, string>; provider?: string; userAgent?: string },
): Promise<JsonValue> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<JsonValue>(async (signal) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(opts.fields)) form.append(key, value);
    const res = await fetchOk(url, {
      method: "POST",
      headers: {
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        ...opts.headers,
      },
      body: form,
      signal,
    }, provider);
    return JsonValueSchema.parse(await res.json());
  });
}

export interface AtsFetchedHtml {
  finalUrl: string;
  html: string;
}

/** Like atsFetchJson but returns raw text (for HTML-island ATSes like Phenom), also capturing the post-redirect URL. */
export async function atsFetchHtml(
  url: string,
  opts: { provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<AtsFetchedHtml> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout(async (signal) => {
    const res = await fetchOk(url, {
      headers: { "User-Agent": opts.userAgent ?? config.fetch.userAgent, Accept: "text/html,application/json", ...(opts.headers ?? {}) },
      redirect: "follow",
      signal,
    }, provider);
    const html = await res.text();
    return { finalUrl: res.url || url, html };
  });
}

/** Like atsFetchJson but returns raw text (for HTML-island ATSes like Phenom). */
export async function atsFetchText(url: string, opts: { provider?: string; userAgent?: string } = {}): Promise<string> {
  const { html } = await atsFetchHtml(url, opts);
  return html;
}

/** POST form-urlencoded, return the HTML response — for form-driven boards (e.g. GoHire) whose list
 *  endpoint only serves page N via a POST body (a plain GET with ?page=N 404s). */
export async function atsFetchFormHtml(
  url: string,
  form: Record<string, string>,
  opts: { provider?: string } = {},
): Promise<string> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout(async (signal) => {
    const res = await fetchOk(url, {
      method: "POST",
      headers: {
        "User-Agent": config.fetch.userAgent,
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal,
    }, provider);
    return await res.text();
  });
}
