import type { Page, Request } from "playwright";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
export const HEAVY_ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css)(?:\?|$)/i;
const SETTLE_MS = 5_000; // let Cloudflare challenge clear + session cookie set

// blockHeavyAssets (default true) aborts images/fonts/video/css; some tenant SPAs (e.g. TurboHire's Ola board) treat ANY aborted request as fatal and reload the frame mid-evaluate - those callers pass blockHeavyAssets: false
export async function withBrowserPage<T>(
  pageUrl: string,
  run: (page: Page) => Promise<T>,
  opts: {
    blockHeavyAssets?: boolean;
    navTimeoutMs?: number;
    /** Wait after `goto` before invoking `run`; default 5000ms settle, pass 0 when `run` does its own settle/poll. */
    settleMs?: number;
    /** Passed to `page.goto` (default "domcontentloaded"); some tenant apps need "networkidle" to let background XHRs quiesce first. */
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
    /** Run right before `goto` to register a listener before navigation fires the requests it watches for. */
    beforeGoto?: (page: Page) => void;
    /** When true, a `goto` failure propagates instead of being swallowed as a presumed WAF/CF interstitial. */
    rethrowGotoErrors?: boolean;
  } = {},
): Promise<T> {
  const blockHeavyAssets = opts.blockHeavyAssets ?? true;
  // wait out an outage before taking a slot - otherwise a network drop looks like a parse error charged to the board (goto failures below are swallowed as presumed interstitials)
  await awaitNetwork();
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
        // A network drop is otherwise indistinguishable from the interstitial this swallow path assumes.
        reportNetworkFailure();
        if (opts.rethrowGotoErrors) throw err;
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

/** Resolves with the first in-flight request matching `urlRe`, or null after `timeoutMs`; register before `goto`. */
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

/** Runs an in-page `fetch` for each apiPath after the browser clears Cloudflare - for gated JSON APIs (Darwinbox) that reject plain Node fetch. */
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

/** One in-page fetch (GET, or POST with a JSON body) to run after the page has cleared the WAF. */
export interface BrowserJsonRequest {
  path: string;
  /** Defaults to GET. */
  method?: "GET" | "POST";
  /** JSON-serialized and sent with a `Content-Type: application/json` header. */
  body?: JsonValue;
}

/** Like {@link browserFetchJson} but each request may be a POST with a JSON body. */
export async function browserFetchJsonRequests(pageUrl: string, requests: BrowserJsonRequest[]): Promise<JsonValue[]> {
  return withBrowserPage(pageUrl, async (page) => {
    const out: JsonValue[] = [];
    for (const req of requests) {
      // stringify on the Node side - a JsonValue-typed page.evaluate arg can exceed TS's instantiation-depth limit (TS2589)
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

// some tenant pages (TurboHire) re-navigate the main frame for several seconds after load, destroying the execution context mid-evaluate or transiently erroring fetch - retry with a settle wait until the churn passes
export const TRANSIENT_EVAL_ERROR_RE = /execution context was destroyed|failed to fetch|target closed/i;
export const MAX_EVAL_ATTEMPTS = 4;

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isTransientEvalError(err: unknown): boolean {
  return TRANSIENT_EVAL_ERROR_RE.test(String(err));
}

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
  // Stringify on the Node side - see the matching comment in browserFetchJsonRequests (TS2589 risk).
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

// runs a sequence of in-page fetches in one session; buildStep gets results-so-far (can thread e.g. a bearer token from an earlier step) and returns null to stop
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
  /** Raw response text per request (not JSON, so callers can decrypt an encrypted body before parsing). */
  bodies: string[];
  /** Every response URL observed during load, so callers can locate a JS bundle without a second navigation. */
  responseUrls: string[];
}

// boots the SPA and returns raw response text per request (e.g. to decrypt TalentRecruit's NaCl-encrypted payload in Node) plus every response URL seen, to locate the seed-bearing bundle
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

