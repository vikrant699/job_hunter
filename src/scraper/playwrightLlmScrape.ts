import { createLlmScrapeAdapter } from "./llmScrape.js";
import { fetchHtmlPlaywright } from "./playwright.js";

/** Same as llmScrapeAdapter but fetches via headless Chromium; SPA sentinel disabled (Playwright IS the fallback), text fallback enabled for Eightfold/iCIMS-style portals. */
export const playwrightScrapeAdapter = createLlmScrapeAdapter({
  tag: "playwright-llm-scrape",
  fetcher: fetchHtmlPlaywright,
  spaSentinel: false,
  textFallback: true,
});
