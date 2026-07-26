// src/ats/http.ts
import { type z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { JsonValue } from "../util/json.js";

/** Build a typed Error for a failed ATS HTTP call. Pure — unit tested. */
export function atsHttpError(provider: string, status: number, bodySnippet: string): Error {
  if (status === 404) return new Error(`${provider} 404`);
  return new Error(`${provider} HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
}

/** Run `fn` with an AbortSignal that fires after `timeoutMs` (default: the
 *  standard ATS timeout). The timeout covers the whole call — headers AND
 *  body consumption — so a stalled body read aborts too. Exported for the
 *  handful of adapters whose fetch shape (raw Response access, bespoke
 *  cookie/session headers) doesn't fit atsFetchJson/atsFetchText, so they can
 *  still get a timeout without hand-rolling AbortController/setTimeout. */
export async function withAtsTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = config.fetch.timeoutMs,
): Promise<T> {
  return fn(AbortSignal.timeout(timeoutMs));
}

/** fetch() that throws `atsHttpError` on a non-OK response. */
async function fetchOk(url: string, init: RequestInit, provider: string): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
  return res;
}

/**
 * Fetch JSON with the standard ATS timeout + UA. Throws `atsHttpError` on a
 * non-OK response. Sends a JSON body (and POST) when `body` is provided.
 */
export async function atsFetchJson(
  url: string,
  opts: { method?: "GET" | "POST"; body?: JsonValue; provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<unknown>(async (signal) => {
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
    return await res.json();
  });
}

export interface ParseCtx { provider: string; slug: string; what?: string }

// Generic parameter is the SCHEMA (`S extends z.ZodType<unknown>`), with the
// returned value typed as `z.infer<S>` — not a bare `<T>(schema: z.ZodType<T>)`.
// Some adapter schemas transform their input (e.g. `id: z.union([z.string(),
// z.number()]).transform(String)`, where Output "string" ≠ Input "string |
// number"); inferring a lone `T` against `z.ZodType<T>` (Input defaults to
// Output) forces TS to unify T against BOTH positions and it picks the
// pre-transform shape, breaking downstream call sites. Constraining on `S`
// and reading `z.infer<S>` off it (an indexed-access lookup, same as z.infer
// itself) sidesteps that and always matches the schema's true output type.
// The explicit `<unknown>` bound (rather than a bare `z.ZodType`, which
// defaults every parameter to `any`) is what keeps `parsed.data` below typed
// as `unknown` instead of `any` inside this generic function body — a bare
// bound trips `@typescript-eslint/no-unsafe-return` on the `return` below.

/** safeParse + warn-log + throw, the shape ~60 adapters hand-rolled. The word
 *  "schema" must stay in the message — scheduler.classifyFetchError tags on it. */
export function parseOrThrow<S extends z.ZodType<unknown>>(schema: S, raw: unknown, ctx: ParseCtx): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "list";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    throw new Error(`${ctx.provider} ${what} response failed schema for ${ctx.slug}`);
  }
  return parsed.data;
}

/** safeParse + warn-log + null, for detail fetches that degrade to "" instead of failing the company. */
export function parseOrNull<S extends z.ZodType<unknown>>(schema: S, raw: unknown, ctx: ParseCtx): z.infer<S> | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "detail";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    return null;
  }
  return parsed.data;
}

/**
 * POST an application/x-www-form-urlencoded body and parse the response as
 * JSON. For ATSes (e.g. RippleHire) whose search endpoint content-negotiates
 * on Accept (defaulting to XML) but returns JSON once we ask for it. Same
 * timeout/UA/error semantics as atsFetchJson.
 */
export async function atsFetchFormJson(
  url: string,
  form: Record<string, string>,
  opts: { provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<unknown>(async (signal) => {
    const res = await fetchOk(url, {
      method: "POST",
      headers: {
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        // Caller headers last so a provider-specific header wins (same
        // ordering convention as atsFetchJson).
        ...(opts.headers ?? {}),
      },
      body: new URLSearchParams(form).toString(),
      signal,
    }, provider);
    return await res.json();
  });
}

/**
 * Like atsFetchJson but sends a multipart/form-data POST (a plain string-keyed
 * fields map, one FormData entry per field) with caller-supplied extra headers.
 * Needed for ATSes (Ceipal) that gate their JSON API on a required `Referer`
 * header and refuse a JSON body. Zwayam's stack rejects the bot UA, so an
 * optional userAgent override is supported. Same timeout/error semantics as atsFetchJson.
 */
export async function atsFetchJsonMultipart(
  url: string,
  opts: { fields: Record<string, string>; headers?: Record<string, string>; provider?: string; userAgent?: string },
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout<unknown>(async (signal) => {
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
    return await res.json();
  });
}

export interface AtsFetchedHtml {
  finalUrl: string;
  html: string;
}

/**
 * Like atsFetchJson but returns raw text (for HTML-island ATSes like Phenom),
 * also capturing the post-redirect URL. Same timeout/UA/error semantics as
 * atsFetchJson.
 */
export async function atsFetchHtml(url: string, opts: { provider?: string; userAgent?: string } = {}): Promise<AtsFetchedHtml> {
  const provider = opts.provider ?? "ats";
  return withAtsTimeout(async (signal) => {
    const res = await fetchOk(url, {
      headers: { "User-Agent": opts.userAgent ?? config.fetch.userAgent, Accept: "text/html,application/json" },
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

/**
 * POST an application/x-www-form-urlencoded body and return the HTML
 * response — for form-driven server-rendered boards (e.g. GoHire) whose list
 * endpoint only serves page N when the pagination fields arrive in a POST
 * body (a plain GET with ?page=N 404s). Same timeout/UA/error semantics as
 * atsFetchHtml.
 */
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
