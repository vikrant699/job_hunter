import { chromium } from "playwright";
import type { Browser } from "playwright";
import { logger } from "../logger.js";
import type { FetchedHtml } from "./cheerio.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { makeSemaphore } from "../util/semaphore.js";
import { envInt } from "../util/env.js";

export interface RenderedPage extends FetchedHtml {
  bodyText: string;
}

const NAV_TIMEOUT_MS = 30_000;
const POST_LOAD_WAIT_NETWORKIDLE_MS = 1_500;
const POST_LOAD_WAIT_FALLBACK_MS = 6_000;
const MAX_CONCURRENT_PAGES = envInt("PLAYWRIGHT_MAX_PAGES", 5);

const EXPAND_MAX_ROUNDS = 8;
const EXPAND_WAIT_MS = 1200;
export const LOAD_MORE_TEXT_RE = /^(load|show|view|see)\s+more\b|^more\s+(jobs|positions|openings|results)\b/i;

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
    const teardown = async () => {
      try { await b.close(); } catch { /* already closed */ }
      sharedBrowser = null;
      bootPromise = null;
    };
    process.once("exit", () => { void teardown(); });
    process.once("SIGINT", () => { void teardown().finally(() => process.exit(0)); });
    process.once("SIGTERM", () => { void teardown().finally(() => process.exit(0)); });
    return b;
  })();
  bootPromise.catch(() => { bootPromise = null; });
  return bootPromise;
}

export async function closePlaywrightBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
    bootPromise = null;
  }
}

export const acquirePageSlot = makeSemaphore(() => MAX_CONCURRENT_PAGES);

const HEAVY_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|m4v|mov|mp3|m4a)(?:\?|$)/i;
const ANALYTICS_HOSTS = /\b(?:google-analytics|googletagmanager|doubleclick|gtag|segment|mixpanel|hotjar|intercom|fullstory|amplitude|optimizely|appsflyer|chartbeat|newrelic)\.(?:com|io|net)/i;

export async function fetchHtmlPlaywright(url: string): Promise<RenderedPage> {
  const release = await acquirePageSlot();
  const t0 = Date.now();
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 800 },
      // Light geo so "is the visitor in the US?" gates default to IN.
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
    try {
      await ctx.route("**/*", (route) => {
        const reqUrl = route.request().url();
        if (HEAVY_EXTENSIONS.test(reqUrl) || ANALYTICS_HOSTS.test(reqUrl)) {
          return route.abort();
        }
        return route.continue();
      });
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      // iCIMS/Eightfold never reach networkidle (analytics keep reconnecting), so fall back to `load`.
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

      try {
        let prevAnchors = await page.locator("a[href]").count();
        for (let round = 0; round < EXPAND_MAX_ROUNDS; round++) {
          await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          const btn = page
            .locator("button, [role='button'], a:not([href]), input[type='button']")
            .filter({ hasText: LOAD_MORE_TEXT_RE })
            .first();
          if ((await btn.count()) > 0) {
            try { await btn.click({ timeout: 1500 }); } catch { /* covered/detached — scroll alone may still load */ }
          }
          await page.waitForTimeout(EXPAND_WAIT_MS);
          const anchors = await page.locator("a[href]").count();
          if (anchors <= prevAnchors) break;
          logger.debug({ url, round, anchors, prevAnchors }, "playwright: listing grew, expanding further");
          prevAnchors = anchors;
        }
      } catch { /* expansion is best-effort; the initial render is still used */ }

      const html = await page.content();
      const finalUrl = page.url();

      // page.content() returns only the parent frame; walk iframes so ATS-redirect detection sees embeds.
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
          // Cross-origin frame - content() blocked, but the URL above is still useful.
        }
      }
      const combined = extras.length > 0 ? `${html}\n<!-- subframes -->\n${extras.join("\n")}` : html;

      let bodyText = "";
      try {
        const evalResult = await page.evaluate("document.body && document.body.innerText || ''");
        bodyText = typeof evalResult === "string" ? evalResult : "";
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
