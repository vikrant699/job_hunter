// src/ats/browserFetch.ts
import type { Page, Request } from "playwright";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
export const HEAVY_ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css)(?:\?|$)/i;
const SETTLE_MS = 5_000; // let Cloudflare challenge clear + session cookie set

/**
 * Load `pageUrl` in a real browser (clears Cloudflare/WAF + sets the
 * session), hand the live `Page` to `run`, then always close the context.
 * Shared plumbing behind `browserFetchJson`, `browserFetchJsonSteps`, and the
 * browser-backed adapters (metacareers/adityabirla/bmw/ubs/reliancebrands/
 * ralphlauren) that need the same acquire-slot/context/route/goto/close shape
 * around a page they drive themselves.
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
export async function withBrowserPage<T>(
  pageUrl: string,
  run: (page: Page) => Promise<T>,
  opts: {
    blockHeavyAssets?: boolean;
    navTimeoutMs?: number;
    /** Wait after `goto` (successful or swallowed) before invoking `run`.
     *  Default 5000ms — lets a Cloudflare/WAF challenge clear + session
     *  cookie set. Callers that do their own settle/poll inside `run` (e.g.
     *  a request-capture poll loop with its own early-exit) pass 0 so the
     *  two waits don't stack. */
    settleMs?: number;
    /** Navigation wait condition passed to `page.goto` (default
     *  "domcontentloaded"). Some tenant apps only fire the request/response
     *  this helper's caller wants to observe once background XHRs quiesce,
     *  which needs "networkidle" instead. */
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
    /** Run right before `goto`, e.g. to register a `page.on("request"/
     *  "response")` listener that must be attached before navigation fires
     *  the requests it wants to observe (mirrors `browserCaptureText`'s own
     *  response-URL capture). */
    beforeGoto?: (page: Page) => void;
    /** When true, a `goto` failure propagates instead of being swallowed as
     *  a presumed WAF/CF interstitial. Default false matches every existing
     *  caller (browserFetchJson/browserFetchJsonRequests/
     *  browserFetchJsonSteps/browserCaptureText and most adapter call
     *  sites), which treat a goto throw as "interstitial, keep going" and
     *  let the settle wait give it time to clear. */
    rethrowGotoErrors?: boolean;
  } = {},
): Promise<T> {
  const blockHeavyAssets = opts.blockHeavyAssets ?? true;
  // Wait out an outage BEFORE taking a page slot or launching a browser. This path
  // matters more than the plain-fetch one: a goto failure is swallowed below as a
  // presumed interstitial, so without this a network drop yields a blank page and
  // the adapter's parse error gets charged to the board as if it were broken.
  await awaitNetwork();
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
        HEAVY_ASSET_RE.test(route.request().url()) ? route.abort() : route.continue());
    }
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(opts.navTimeoutMs ?? 30_000);
      opts.beforeGoto?.(page);
      try {
        await page.goto(pageUrl, { waitUntil: opts.waitUntil ?? "domcontentloaded" });
        reportNetworkSuccess();
      } catch (err) {
        // Ask for a probe: this is the swallow path, so a network drop would
        // otherwise be indistinguishable from the interstitial it assumes.
        reportNetworkFailure();
        if (opts.rethrowGotoErrors) throw err;
        /* CF interstitial */
      }
      await page.waitForTimeout(opts.settleMs ?? SETTLE_MS);
      return await run(page);
    } finally {
      await ctx.close();
    }
  } finally {
    release();
  }
}

/**
 * Resolve with the first in-flight request whose URL matches `urlRe`, or
 * `null` after `timeoutMs`. Register this BEFORE `goto` (e.g. from
 * `withBrowserPage`'s `beforeGoto`) — the request it's watching for is
 * typically fired by the page's own JS during/soon after initial load, so a
 * listener attached after navigation starts can miss it. The listener and
 * timer are always torn down on resolution (whichever comes first), so
 * nothing is left dangling.
 */
export function captureFirstRequest(page: Page, urlRe: RegExp, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const onRequest = (req: Request): void => {
      if (!urlRe.test(req.url())) return;
      cleanup();
      resolve(req.url());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup(): void {
      page.off("request", onRequest);
      clearTimeout(timer);
    }
    page.on("request", onRequest);
  });
}

/**
 * Load `pageUrl` in a real browser (clears Cloudflare + sets the session),
 * then run an in-page `fetch` for each apiPath, returning parsed JSON per path.
 * For Cloudflare-gated JSON APIs (Darwinbox) that reject plain Node fetch.
 */
export async function browserFetchJson(
  pageUrl: string,
  apiPaths: string[],
  opts: { blockHeavyAssets?: boolean } = {},
): Promise<JsonValue[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: JsonValue[] = [];
    for (const path of apiPaths) {
      const json = await page.evaluate(async (p) => {
        const res = await fetch(p, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      }, path);
      out.push(JsonValueSchema.parse(json));
    }
    return out;
  }, opts);
}

/** One in-page fetch (GET, or POST with a JSON body) to run after the page
 *  has cleared the WAF. */
export interface BrowserJsonRequest {
  path: string;
  /** Defaults to GET. */
  method?: "GET" | "POST";
  /** JSON-serialized and sent with a `Content-Type: application/json` header. */
  body?: JsonValue;
}

/**
 * Like {@link browserFetchJson} but each request may be a POST with a JSON body
 * (e.g. Darwinbox candidatev2's `/ms/candidateapi/job/alljobs` POST). Reuses the
 * same WAF-clearing plumbing.
 */
export async function browserFetchJsonRequests(pageUrl: string, requests: BrowserJsonRequest[]): Promise<JsonValue[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: JsonValue[] = [];
    for (const req of requests) {
      // Stringify the body on the Node side (not inside the evaluated closure):
      // passing a JsonValue through page.evaluate's Arg makes Playwright's
      // recursive Unboxed<Arg> mapped type recurse into our own recursive
      // JsonValue, which can blow TS's instantiation-depth limit (TS2589).
      // A plain string in Arg sidesteps that entirely.
      const bodyJson = req.body !== undefined ? JSON.stringify(req.body) : undefined;
      const json = await page.evaluate(async ({ path, method, bodyJson }) => {
        const res = await fetch(path, {
          method: method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(bodyJson !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(bodyJson !== undefined ? { body: bodyJson } : {}),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      }, { path: req.path, method: req.method, bodyJson });
      out.push(JsonValueSchema.parse(json));
    }
    return out;
  });
}

export interface BrowserJsonStep {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: JsonValue;
}

// Some tenant pages (TurboHire's careerpage app) keep re-navigating the main
// frame to itself for several seconds after load (observed on the Ola
// tenant — ~10 same-URL `framenavigated` events in a row, plausibly a
// polling/heartbeat routine using `history.replaceState` or a full reload),
// which can destroy the execution context mid-`page.evaluate`; a
// still-settling page can also briefly answer `fetch` with a network error.
// Both are transient — retry with a settle wait until the churn passes.
export const TRANSIENT_EVAL_ERROR_RE = /execution context was destroyed|failed to fetch|target closed/i;
export const MAX_EVAL_ATTEMPTS = 4;

// A caught/thrown value has no narrower type in TS — this predicate exists to narrow it.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isTransientEvalError(err: unknown): boolean {
  return TRANSIENT_EVAL_ERROR_RE.test(String(err));
}

/** Retry `run` on transient eval errors (settle() between attempts), up to
 *  MAX_EVAL_ATTEMPTS total. Non-transient errors and the final attempt throw. */
export async function runWithEvalRetry<T>(run: () => Promise<T>, settle: () => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= MAX_EVAL_ATTEMPTS || !isTransientEvalError(err)) throw err;
      await settle();
    }
  }
}

async function evaluateStepWithRetry(page: Page, step: BrowserJsonStep): Promise<JsonValue> {
  // Stringify the body on the Node side — see the matching comment in
  // browserFetchJsonRequests: a JsonValue-typed Arg makes Playwright's
  // recursive Unboxed<Arg> mapped type recurse into JsonValue's own
  // recursive union, which can exceed TS's instantiation-depth limit.
  const bodyJson = step.body !== undefined ? JSON.stringify(step.body) : undefined;
  return JsonValueSchema.parse(await runWithEvalRetry(
    () =>
      page.evaluate(async ({ url, method, headers, bodyJson }) => {
        const res = await fetch(url, {
          method: method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(bodyJson !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(headers ?? {}),
          },
          ...(bodyJson !== undefined ? { body: bodyJson } : {}),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      }, { url: step.url, method: step.method, headers: step.headers, bodyJson }),
    async () => {
      await page.waitForLoadState("domcontentloaded").catch(() => { /* no pending navigation */ });
      await page.waitForTimeout(SETTLE_MS);
    },
  ));
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
  buildStep: (resultsSoFar: JsonValue[]) => BrowserJsonStep | null,
  opts: { blockHeavyAssets?: boolean } = {},
): Promise<JsonValue[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: JsonValue[] = [];
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
  const responseUrls: string[] = [];
  const bodies = await withBrowserPage(
    pageUrl,
    async (page) => {
      const out: string[] = [];
      for (const req of requests) {
        const body = await page.evaluate(async ({ url, headers }) => {
          const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          return await res.text();
        }, { url: req.url, headers: req.headers ?? {} });
        out.push(body);
      }
      return out;
    },
    {
      navTimeoutMs: 45_000,
      beforeGoto: (page) => { page.on("response", (resp) => { responseUrls.push(resp.url()); }); },
    },
  );
  return { bodies, responseUrls };
}

