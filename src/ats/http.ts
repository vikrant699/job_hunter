// src/ats/http.ts
import { config } from "../config.js";

/** Build a typed Error for a failed ATS HTTP call. Pure — unit tested. */
export function atsHttpError(provider: string, status: number, bodySnippet: string): Error {
  if (status === 404) return new Error(`${provider} 404`);
  return new Error(`${provider} HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
}

/**
 * Fetch JSON with the standard ATS timeout + UA. Throws `atsHttpError` on a
 * non-OK response. Sends a JSON body (and POST) when `body` is provided.
 */
export async function atsFetchJson(
  url: string,
  opts: { method?: "GET" | "POST"; body?: unknown; provider?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        // Some WAF-fronted boards (Jibe) 403 the bot UA — those pass a browser UA.
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Caller headers last so a provider-specific header (webbtree customurl) wins.
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  opts: { provider?: string } = {},
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": config.fetch.userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(opts.fields)) form.append(key, value);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": opts.userAgent ?? config.fetch.userAgent,
        Accept: "application/json",
        ...opts.headers,
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": opts.userAgent ?? config.fetch.userAgent, Accept: "text/html,application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
    const html = await res.text();
    return { finalUrl: res.url || url, html };
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": config.fetch.userAgent,
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError(provider, res.status, await res.text());
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
