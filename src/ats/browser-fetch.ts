// src/ats/browser-fetch.ts
import type { Page } from "playwright";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/user-agent.js";
const HEAVY = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css)(?:\?|$)/i;
const SETTLE_MS = 5_000; // let Cloudflare challenge clear + session cookie set

/**
 * Load `pageUrl` in a real browser (clears Cloudflare/WAF + sets the
 * session), hand the live `Page` to `run`, then always close the context.
 * Shared plumbing behind `browserFetchJson` and `browserFetchJsonSteps`.
 *
 * `blockHeavyAssets` (default true) aborts images/fonts/video/css to save
 * bandwidth. Some tenant apps (TurboHire's Ola careerpage, confirmed live)
 * treat ANY aborted request — even an unrelated stylesheet — as a fatal
 * error and respond by reloading the main frame in a tight loop, which can
 * destroy the execution context mid-`page.evaluate`. Callers that hit that
 * pass `blockHeavyAssets: false` to let the page load unmolested; it's still
 * a one-shot token/API handshake, not a full scrape, so the extra bytes are
 * cheap.
 */
async function withBrowserPage<T>(
  pageUrl: string,
  run: (page: Page) => Promise<T>,
  opts: { blockHeavyAssets?: boolean } = {},
): Promise<T> {
  const blockHeavyAssets = opts.blockHeavyAssets ?? true;
  // Outer try guarantees the page slot is released even if getBrowser /
  // newContext / route throws; inner try guarantees the context is closed.
  const release = await acquirePageSlot();
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
      locale: "en-US", timezoneId: "Asia/Kolkata",
    });
    if (blockHeavyAssets) {
      await ctx.route("**/*", (route) =>
        HEAVY.test(route.request().url()) ? route.abort() : route.continue());
    }
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(30_000);
      try { await page.goto(pageUrl, { waitUntil: "domcontentloaded" }); } catch { /* CF interstitial */ }
      await page.waitForTimeout(SETTLE_MS);
      return await run(page);
    } finally {
      await ctx.close();
    }
  } finally {
    release();
  }
}

/**
 * Load `pageUrl` in a real browser (clears Cloudflare + sets the session),
 * then run an in-page `fetch` for each apiPath, returning parsed JSON per path.
 * For Cloudflare-gated JSON APIs (Darwinbox) that reject plain Node fetch.
 */
export async function browserFetchJson(pageUrl: string, apiPaths: string[]): Promise<unknown[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: unknown[] = [];
    for (const path of apiPaths) {
      const json = await page.evaluate(async (p) => {
        const res = await fetch(p, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      }, path);
      out.push(json);
    }
    return out;
  });
}

/** One in-page fetch (GET, or POST with a JSON body) to run after the page
 *  has cleared the WAF. */
export interface BrowserJsonRequest {
  path: string;
  /** Defaults to GET. */
  method?: "GET" | "POST";
  /** JSON-serialized and sent with a `Content-Type: application/json` header. */
  body?: unknown;
}

/**
 * Like {@link browserFetchJson} but each request may be a POST with a JSON body
 * (e.g. Darwinbox candidatev2's `/ms/candidateapi/job/alljobs` POST). Reuses the
 * same WAF-clearing plumbing.
 */
export async function browserFetchJsonRequests(pageUrl: string, requests: BrowserJsonRequest[]): Promise<unknown[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: unknown[] = [];
    for (const req of requests) {
      const json = await page.evaluate(async (r) => {
        const res = await fetch(r.path, {
          method: r.method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(r.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      }, req);
      out.push(json);
    }
    return out;
  });
}

export interface BrowserJsonStep {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

// Some tenant pages (TurboHire's careerpage app) keep re-navigating the main
// frame to itself for several seconds after load (observed on the Ola
// tenant — ~10 same-URL `framenavigated` events in a row, plausibly a
// polling/heartbeat routine using `history.replaceState` or a full reload),
// which can destroy the execution context mid-`page.evaluate`; a
// still-settling page can also briefly answer `fetch` with a network error.
// Both are transient — retry with a settle wait until the churn passes.
const TRANSIENT_EVAL_ERROR_RE = /execution context was destroyed|failed to fetch|target closed/i;
const MAX_EVAL_ATTEMPTS = 4;

async function evaluateStepWithRetry(page: Page, step: BrowserJsonStep): Promise<unknown> {
  const run = () =>
    page.evaluate(async (s) => {
      const res = await fetch(s.url, {
        method: s.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(s.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(s.headers ?? {}),
        },
        body: s.body !== undefined ? JSON.stringify(s.body) : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }, step);
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= MAX_EVAL_ATTEMPTS || !TRANSIENT_EVAL_ERROR_RE.test(String(err))) throw err;
      await page.waitForLoadState("domcontentloaded").catch(() => { /* no pending navigation */ });
      await page.waitForTimeout(SETTLE_MS);
    }
  }
}

/**
 * Load `pageUrl` in a real browser (clears the WAF), then run a SEQUENCE of
 * in-page fetches, one at a time, in the same page/session. Unlike
 * `browserFetchJson` (a fixed list of GET paths), each step here can be a
 * POST with arbitrary headers/body, and — because `buildStep` is called
 * again after every response — a later step can use data from an earlier one
 * (e.g. thread a bearer token fetched in step 1 into step 2's Authorization
 * header). `buildStep` receives every parsed JSON response collected so far
 * and returns the next request, or `null` to stop.
 *
 * For anon-token-handshake APIs (TurboHire: `GET .../token/noauth` then
 * `POST .../filteredjobs` with that bearer token) whose token host WAF-blocks
 * plain Node fetch — same "load a real page to clear the WAF, then fetch
 * in-page" trick as `browserFetchJson`, generalized to POST + headers.
 * `opts.blockHeavyAssets` is forwarded to `withBrowserPage` (see there).
 */
export async function browserFetchJsonSteps(
  pageUrl: string,
  buildStep: (resultsSoFar: unknown[]) => BrowserJsonStep | null,
  opts: { blockHeavyAssets?: boolean } = {},
): Promise<unknown[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: unknown[] = [];
    for (;;) {
      const step = buildStep(out);
      if (!step) break;
      out.push(await evaluateStepWithRetry(page, step));
    }
    return out;
  }, opts);
}

export interface InPageRequest {
  /** Absolute URL to fetch from inside the page. */
  url: string;
  /** Extra request headers (e.g. a tenant-context header the SPA normally adds). */
  headers?: Record<string, string>;
}

export interface BrowserCapture {
  /** Raw response text per request, in the same order as `requests`. Text (not
   *  JSON) so callers can decrypt an encrypted body before parsing. */
  bodies: string[];
  /** Every response URL the page observed during load — lets callers locate a
   *  JS bundle (e.g. `main.<hash>.js`) without a second navigation. */
  responseUrls: string[];
}

/**
 * Load `pageUrl` in a real browser (boots the SPA / clears Cloudflare + session),
 * recording every response URL, then run each `requests[i]` as an in-page fetch
 * (with optional headers) and return the raw response text.
 *
 * Differs from {@link browserFetchJson} in three ways it needs for TalentRecruit:
 * per-request headers (the jobs API is tenant-gated by a `shortname` header the
 * SPA injects), raw-text bodies (the payload is NaCl-encrypted, decrypted in
 * Node), and the observed response URL list (to find the seed-bearing bundle).
 */
export async function browserCaptureText(
  pageUrl: string,
  requests: InPageRequest[],
): Promise<BrowserCapture> {
  const release = await acquirePageSlot();
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
      locale: "en-US", timezoneId: "Asia/Kolkata",
    });
    await ctx.route("**/*", (route) =>
      HEAVY.test(route.request().url()) ? route.abort() : route.continue());
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(45_000);
      const responseUrls: string[] = [];
      page.on("response", (resp) => { responseUrls.push(resp.url()); });
      try { await page.goto(pageUrl, { waitUntil: "domcontentloaded" }); } catch { /* CF interstitial */ }
      await page.waitForTimeout(SETTLE_MS);
      const bodies: string[] = [];
      for (const req of requests) {
        const body = await page.evaluate(async ({ url, headers }) => {
          const res = await fetch(url, { headers: { Accept: "application/json", ...(headers ?? {}) } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          return await res.text();
        }, { url: req.url, headers: req.headers ?? {} });
        bodies.push(body);
      }
      return { bodies, responseUrls };
    } finally {
      await ctx.close();
    }
  } finally {
    release();
  }
}
