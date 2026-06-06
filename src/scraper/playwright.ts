import { chromium, type Browser } from "playwright";
import { logger } from "../logger.js";
import type { FetchedHtml } from "./cheerio.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { makeSemaphore } from "../util/semaphore.js";

export interface RenderedPage extends FetchedHtml {
  /** Visible body text — captures content even when jobs render outside <a>. */
  bodyText: string;
}

// Headless-Chromium fetcher for SPA careers pages. One shared Browser
// instance; per-call Context so cookies don't leak; heavy assets aborted
// at the route level; concurrent pages capped to control RAM.

const NAV_TIMEOUT_MS = 30_000;
// Settle after primary load: short under networkidle (JS hydrated during goto),
// longer under the load/domcontentloaded fallback so SPAs can boot + XHR.
const POST_LOAD_WAIT_NETWORKIDLE_MS = 1_500;
const POST_LOAD_WAIT_FALLBACK_MS = 6_000;
const MAX_CONCURRENT_PAGES = Number(process.env.PLAYWRIGHT_MAX_PAGES ?? 5);

// ---- shared browser lifecycle ----

let sharedBrowser: Browser | null = null;
let bootPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    logger.info("playwright: launching headless chromium");
    const b = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    sharedBrowser = b;
    // Auto-close on process exit so we don't leak a stray chrome process.
    const teardown = async () => {
      try { await b.close(); } catch { /* already closed */ }
      sharedBrowser = null;
    };
    process.once("exit", () => { teardown(); });
    process.once("SIGINT", () => { teardown().then(() => process.exit(0)); });
    process.once("SIGTERM", () => { teardown().then(() => process.exit(0)); });
    return b;
  })();
  return bootPromise;
}

/** Explicit shutdown for tests; long-running mode never needs this. */
export async function closePlaywrightBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
    bootPromise = null;
  }
}

// ---- concurrency gate ----

export const acquirePageSlot = makeSemaphore(() => MAX_CONCURRENT_PAGES);

// ---- resource blocking ----

const HEAVY_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|m4v|mov|mp3|m4a)(?:\?|$)/i;
const ANALYTICS_HOSTS = /\b(?:google-analytics|googletagmanager|doubleclick|gtag|segment|mixpanel|hotjar|intercom|fullstory|amplitude|optimizely|appsflyer|chartbeat|newrelic)\.(?:com|io|net)/i;

// ---- public API ----

/**
 * Render a URL in a browser tab and return DOM HTML + body innerText. Shape
 * is compatible with cheerio.fetchHtml so the llm-scrape pipeline swaps
 * fetchers transparently.
 */
export async function fetchHtmlPlaywright(url: string): Promise<RenderedPage> {
  const release = await acquirePageSlot();
  const t0 = Date.now();
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 800 },
      // Light geo so any "is the visitor in the US?" gates default to IN.
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
    // Drop heavy assets — saves ~80% of bandwidth without affecting job-list HTML.
    await ctx.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (HEAVY_EXTENSIONS.test(reqUrl) || ANALYTICS_HOSTS.test(reqUrl)) {
        return route.abort();
      }
      return route.continue();
    });
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      // networkidle works for most SPAs. iCIMS/Eightfold etc. never settle
      // (analytics keep reconnecting) so we fall back to `load` + longer wait.
      let waitedNetworkIdle = true;
      try {
        await page.goto(url, { waitUntil: "networkidle" });
      } catch (err) {
        waitedNetworkIdle = false;
        logger.debug({ url, err: String(err).slice(0, 100) }, "playwright: networkidle timed out, falling back");
        try {
          await page.goto(url, { waitUntil: "load" });
        } catch {
          await page.goto(url, { waitUntil: "domcontentloaded" });
        }
      }
      const settleMs = waitedNetworkIdle ? POST_LOAD_WAIT_NETWORKIDLE_MS : POST_LOAD_WAIT_FALLBACK_MS;
      if (settleMs > 0) {
        await page.waitForTimeout(settleMs);
      }
      const html = await page.content();
      const finalUrl = page.url();

      // Walk iframes — page.content() returns only the parent frame. We
      // include subframe URLs (so ATS-redirect detection sees the embed host)
      // and same-origin HTML (so cheerio sees the embedded <a> tags).
      const subframes = page.frames().filter((f) => f !== page.mainFrame());
      const extras: string[] = [];
      for (const f of subframes) {
        const fUrl = f.url();
        if (!fUrl || fUrl === "about:blank" || fUrl.startsWith("data:")) continue;
        extras.push(`<!-- iframe src="${fUrl}" --><a href="${fUrl}">${fUrl}</a>`);
        try {
          const fHtml = await f.content();
          if (fHtml && fHtml.length > 0) extras.push(fHtml);
        } catch {
          // Cross-origin frame — content() blocked, but the URL above is still
          // useful evidence for the ATS-redirect detector.
        }
      }
      const combined = extras.length > 0 ? `${html}\n<!-- subframes -->\n${extras.join("\n")}` : html;

      // body.innerText recovers Eightfold/iCIMS where jobs render outside <a>.
      // Pass the eval as a string so it runs in the browser context.
      let bodyText = "";
      try {
        bodyText = (await page.evaluate("document.body && document.body.innerText || ''")) as string;
      } catch { /* page closed mid-eval */ }

      logger.debug(
        { url, finalUrl, ms: Date.now() - t0, bytes: combined.length, subframes: subframes.length, textBytes: bodyText.length },
        "playwright: rendered"
      );
      return { finalUrl, html: combined, bodyText };
    } finally {
      await ctx.close();
    }
  } finally {
    release();
  }
}
