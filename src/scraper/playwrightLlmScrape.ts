import { createLlmScrapeAdapter } from "./llmScrape.js";
import { fetchHtmlPlaywright } from "./playwright.js";

/**
 * Same logic as llmScrapeAdapter but fetches via headless Chromium for SPA
 * careers pages. SPA sentinel is disabled (Playwright IS the fallback) and
 * text fallback is enabled to recover Eightfold/iCIMS-style portals where
 * jobs aren't anchored.
 */
export const playwrightScrapeAdapter = createLlmScrapeAdapter({
  tag: "playwright-llm-scrape",
  fetcher: fetchHtmlPlaywright,
  spaSentinel: false,
  textFallback: true,
});
