import { createLlmScrapeAdapter } from "./llmScrape.js";
import { fetchHtmlPlaywright } from "./playwright.js";

export const playwrightScrapeAdapter = createLlmScrapeAdapter({
  tag: "playwright-llm-scrape",
  fetcher: fetchHtmlPlaywright,
  spaSentinel: false,
  textFallback: true,
});
