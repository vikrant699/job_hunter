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
  opts: { method?: "GET" | "POST"; body?: unknown; provider?: string; userAgent?: string } = {},
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

export interface AtsFetchedHtml {
  finalUrl: string;
  html: string;
}

/**
 * Like atsFetchJson but returns raw text (for HTML-island ATSes like Phenom),
 * also capturing the post-redirect URL. Same timeout/UA/error semantics as
 * atsFetchJson.
 */
export async function atsFetchHtml(url: string, opts: { provider?: string } = {}): Promise<AtsFetchedHtml> {
  const provider = opts.provider ?? "ats";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.fetch.userAgent, Accept: "text/html,application/json" },
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
export async function atsFetchText(url: string, opts: { provider?: string } = {}): Promise<string> {
  const { html } = await atsFetchHtml(url, opts);
  return html;
}
