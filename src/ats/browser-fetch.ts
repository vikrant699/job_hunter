// src/ats/browser-fetch.ts
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEAVY = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css)(?:\?|$)/i;
const SETTLE_MS = 5_000; // let Cloudflare challenge clear + session cookie set

/**
 * Load `pageUrl` in a real browser (clears Cloudflare + sets the session),
 * then run an in-page `fetch` for each apiPath, returning parsed JSON per path.
 * For Cloudflare-gated JSON APIs (Darwinbox) that reject plain Node fetch.
 */
export async function browserFetchJson(pageUrl: string, apiPaths: string[]): Promise<unknown[]> {
  const release = await acquirePageSlot();
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
    locale: "en-US", timezoneId: "Asia/Kolkata",
  });
  await ctx.route("**/*", (route) =>
    HEAVY.test(route.request().url()) ? route.abort() : route.continue());
  try {
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(30_000);
    try { await page.goto(pageUrl, { waitUntil: "domcontentloaded" }); } catch { /* CF interstitial */ }
    await page.waitForTimeout(SETTLE_MS);
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
  } finally {
    await ctx.close();
    release();
  }
}
