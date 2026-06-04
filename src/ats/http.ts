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
  opts: { method?: "GET" | "POST"; body?: unknown; provider?: string } = {},
): Promise<unknown> {
  const provider = opts.provider ?? "ats";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        "User-Agent": config.fetch.userAgent,
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
