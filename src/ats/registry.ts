import type { AtsAdapter } from "./types.js";
import type { Company } from "../types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { workdayAdapter } from "./workday.js";
import { smartRecruitersAdapter } from "./smartrecruiters.js";
import { workableAdapter } from "./workable.js";
import { kekaAdapter } from "./keka.js";
import { eightfoldAdapter } from "./eightfold.js";
import { oracleAdapter } from "./oracle.js";
import { phenomAdapter } from "./phenom.js";
import { darwinboxAdapter } from "./darwinbox.js";
import { greythrAdapter } from "./greythr.js";
import { llmScrapeAdapter } from "../scraper/llm-scrape.js";
import { playwrightScrapeAdapter } from "../scraper/playwright-llm-scrape.js";

export const ATS_ADAPTERS: Record<string, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
  smartrecruiters: smartRecruitersAdapter,
  workable: workableAdapter,
  keka: kekaAdapter,
  eightfold: eightfoldAdapter,
  oracle: oracleAdapter,
  phenom: phenomAdapter,
  darwinbox: darwinboxAdapter,
  greythr: greythrAdapter,
};

export function resolveAdapter(c: Company): AtsAdapter | null {
  if (c.parsingStrategy === "llm-scrape") return llmScrapeAdapter;
  if (c.parsingStrategy === "playwright-llm-scrape") return playwrightScrapeAdapter;
  if (c.parsingStrategy === "ats-api") return ATS_ADAPTERS[c.provider] ?? null;
  return null;
}
