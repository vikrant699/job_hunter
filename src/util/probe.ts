// Shared AbortController+setTimeout+fetch+clearTimeout mechanics for the
// ops/maintenance scripts (slug-probe, verify-registry) that each
// independently probe a URL and inspect the result. Only the fetch plumbing
// is unified here; each script keeps its own status/body interpretation.

export interface ProbeOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  redirect?: "follow" | "manual" | "error";
}

export interface ProbeResponse {
  /** HTTP status code, or 0 when the request failed before a response (network error/timeout). */
  status: number;
  /** Post-redirect URL (falls back to the requested URL when unavailable). */
  finalUrl: string;
  /** Response body as text. Empty string when the request failed or the body couldn't be read. */
  body: string;
  /** true for a 2xx response. */
  ok: boolean;
}

/**
 * Fetch a URL with a timeout, never throwing — network errors, aborts, and
 * body-read failures all collapse into a `{ ok: false, status: 0 }` result so
 * callers can treat "couldn't check" uniformly with "checked and it's broken".
 */
export async function probeWithTimeout(url: string, opts: ProbeOptions = {}): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      redirect: opts.redirect ?? "follow",
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    let body = "";
    try {
      body = await res.text();
    } catch {
      // Body read failed — treat as unverifiable, status/ok still valid.
    }
    return { status: res.status, finalUrl, body, ok: res.ok };
  } catch {
    return { status: 0, finalUrl: url, body: "", ok: false };
  } finally {
    clearTimeout(timer);
  }
}
