import type { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { isRetryableHttpStatus, parseRetryAfterMs } from "../util/httpRetry.js";
import { sleep } from "../util/sleep.js";
import { fetchRepairingChain } from "../util/aiaChain.js";

export function atsHttpError(provider: string, status: number, bodySnippet: string): Error {
  if (status === 404) return new Error(`${provider} 404`);
  return new Error(`${provider} HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
}

/** Total tries (1 + 2 retries) for 429/5xx; not tunable per board. */
const ATS_RETRY_ATTEMPTS = 3;

export async function withAtsTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = config.fetch.timeoutMs,
): Promise<T> {
  return fn(AbortSignal.timeout(timeoutMs));
}

// every atsFetch* helper funnels through here, which is why the connectivity gate lives here
async function fetchOk(url: string, init: RequestInit, provider: string): Promise<Response> {
  const callerSignal = init.signal;
  for (let attempt = 0; attempt < ATS_RETRY_ATTEMPTS; attempt++) {
    await awaitNetwork();
    // retries get a fresh per-attempt timeout; attempt 0 keeps the caller's signal
    const attemptInit: RequestInit = attempt === 0 ? init : { ...init, signal: AbortSignal.timeout(config.fetch.timeoutMs) };
    let res: Response;
    try {
      res = await fetchRepairingChain(url, attemptInit);
    } catch (err) {
      reportNetworkFailure();
      throw err;
    }
    // ANY response proves the connection works, including a 403 from a bot-blocker — that's about the board, not the network.
    reportNetworkSuccess();
    if (res.ok) return res;

    const lastAttempt = attempt === ATS_RETRY_ATTEMPTS - 1;
    const willRetry = !lastAttempt && isRetryableHttpStatus(res.status) && callerSignal?.aborted !== true;
    if (!willRetry) {
      const body = await res.text();
      // scan the FULL body for WAF signatures before atsHttpError truncates to 200 chars; edge challenges are infra faults, not charged to the row
      assertNotEdgeChallenge(provider, url, body);
      throw atsHttpError(provider, res.status, body);
    }

    await res.body?.cancel();
    const retryAfter = res.headers.get("retry-after");
    const waitMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : 1000 * 2 ** attempt;
    await sleep(waitMs);
  }
  throw new Error(`${provider}: retry loop exited without resolving`);
}

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

/** safeParse + warn + throw; "schema" must stay in the message: scheduler.classifyFetchError tags on it. */
export function parseOrThrow<Out, In>(schema: z.ZodType<Out, z.ZodTypeDef, In>, raw: JsonValue, ctx: ParseCtx): Out {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "list";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    throw new Error(`${ctx.provider} ${what} response failed schema for ${ctx.slug}`);
  }
  return parsed.data;
}

export function parseOrNull<Out, In>(schema: z.ZodType<Out, z.ZodTypeDef, In>, raw: JsonValue, ctx: ParseCtx): Out | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const what = ctx.what ?? "detail";
    logger.warn({ slug: ctx.slug, issues: parsed.error.issues.slice(0, 3) }, `${ctx.provider} ${what} schema mismatch`);
    return null;
  }
  return parsed.data;
}

/** POST form-urlencoded, parse JSON; for ATSes (RippleHire) that default to XML unless Accept asks for JSON. */
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
        ...(opts.headers ?? {}),
      },
      body: new URLSearchParams(form).toString(),
      signal,
    }, provider);
    return JsonValueSchema.parse(await res.json());
  });
}

/** multipart/form-data POST; for ATSes (Ceipal) that require a Referer and refuse a JSON body. */
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

export async function atsFetchText(url: string, opts: { provider?: string; userAgent?: string } = {}): Promise<string> {
  const { html } = await atsFetchHtml(url, opts);
  return html;
}

/** POST form-urlencoded, return HTML; for boards (GoHire) whose page N is only served via POST (GET ?page=N 404s). */
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
