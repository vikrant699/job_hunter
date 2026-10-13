export interface ProbeOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  redirect?: "follow" | "manual" | "error";
}

export interface ProbeResponse {
  status: number;
  finalUrl: string;
  body: string;
  ok: boolean;
}

export async function probeWithTimeout(url: string, opts: ProbeOptions = {}): Promise<ProbeResponse> {
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      redirect: opts.redirect ?? "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
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
  }
}
