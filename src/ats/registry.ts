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
import { eightfoldPcsAdapter } from "./eightfoldpcs.js";
import { oracleAdapter } from "./oracle.js";
import { phenomAdapter } from "./phenom.js";
import { darwinboxAdapter } from "./darwinbox.js";
import { greythrAdapter } from "./greythr.js";
import { jibeAdapter } from "./jibe.js";
import { zohorecruitAdapter } from "./zohorecruit.js";
import { successfactorsAdapter } from "./successfactors.js";
import { peoplestrongAdapter } from "./peoplestrong.js";
import { ainterviewsAdapter } from "./ainterviews.js";
import { recruiteeAdapter } from "./recruitee.js";
import { freshteamAdapter } from "./freshteam.js";
import { gohireAdapter } from "./gohire.js";
import { jobsoidAdapter } from "./jobsoid.js";
import { ceipalAdapter } from "./ceipal.js";
import { ripplehireAdapter } from "./ripplehire.js";
import { zwayamAdapter } from "./zwayam.js";
import { sensehqAdapter } from "./sensehq.js";
import { breezyhrAdapter } from "./breezyhr.js";
import { turbohireAdapter } from "./turbohire.js";
import { avatureAdapter } from "./avature.js";
import { jazzhrAdapter } from "./jazzhr.js";
import { webbtreeAdapter } from "./webbtree.js";
import { zappyhireAdapter } from "./zappyhire.js";
import { talentRecruitAdapter } from "./talentrecruit.js";
import { trakstarAdapter } from "./trakstar.js";
import { sharechatAdapter } from "./sharechat.js";
import { amazonJobsAdapter } from "./amazonjobs.js";
import { wpjobsAdapter } from "./wpjobs.js";
import { mynexthireAdapter } from "./mynexthire.js";
import { metacareersAdapter } from "./metacareers.js";
import { gemAdapter } from "./gem.js";
import { doverAdapter } from "./dover.js";
import { ycombinatorAdapter } from "./ycombinator.js";
import { icicibankAdapter } from "./icicibank.js";
import { relianceAdapter } from "./reliance.js";
import { magicpinAdapter } from "./magicpin.js";
import { tatacareersAdapter } from "./tatacareers.js";
import { peoplehumAdapter } from "./peoplehum.js";
import { leapscholarAdapter } from "./leapscholar.js";
import { bambooHrAdapter } from "./bamboohr.js";
import { setuAdapter } from "./setu.js";
import { radancyAdapter } from "./radancy.js";
import { atlassianAdapter } from "./atlassian.js";
import { kulaAdapter } from "./kula.js";
import { urbancompanyAdapter } from "./urbancompany.js";
import { happyeasygoAdapter } from "./happyeasygo.js";
import { adityabirlaAdapter } from "./adityabirla.js";
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
  eightfoldpcs: eightfoldPcsAdapter,
  oracle: oracleAdapter,
  phenom: phenomAdapter,
  darwinbox: darwinboxAdapter,
  greythr: greythrAdapter,
  jibe: jibeAdapter,
  zohorecruit: zohorecruitAdapter,
  successfactors: successfactorsAdapter,
  peoplestrong: peoplestrongAdapter,
  ainterviews: ainterviewsAdapter,
  recruitee: recruiteeAdapter,
  freshteam: freshteamAdapter,
  gohire: gohireAdapter,
  jobsoid: jobsoidAdapter,
  ceipal: ceipalAdapter,
  ripplehire: ripplehireAdapter,
  zwayam: zwayamAdapter,
  sensehq: sensehqAdapter,
  breezyhr: breezyhrAdapter,
  turbohire: turbohireAdapter,
  avature: avatureAdapter,
  jazzhr: jazzhrAdapter,
  webbtree: webbtreeAdapter,
  zappyhire: zappyhireAdapter,
  talentrecruit: talentRecruitAdapter,
  trakstar: trakstarAdapter,
  sharechat: sharechatAdapter,
  amazonjobs: amazonJobsAdapter,
  wpjobs: wpjobsAdapter,
  mynexthire: mynexthireAdapter,
  metacareers: metacareersAdapter,
  gem: gemAdapter,
  dover: doverAdapter,
  ycombinator: ycombinatorAdapter,
  icicibank: icicibankAdapter,
  reliance: relianceAdapter,
  magicpin: magicpinAdapter,
  tatacareers: tatacareersAdapter,
  peoplehum: peoplehumAdapter,
  leapscholar: leapscholarAdapter,
  bamboohr: bambooHrAdapter,
  setu: setuAdapter,
  radancy: radancyAdapter,
  atlassian: atlassianAdapter,
  kula: kulaAdapter,
  urbancompany: urbancompanyAdapter,
  happyeasygo: happyeasygoAdapter,
  adityabirla: adityabirlaAdapter,
};

export function resolveAdapter(c: Company): AtsAdapter | null {
  if (c.parsingStrategy === "llm-scrape") return llmScrapeAdapter;
  if (c.parsingStrategy === "playwright-llm-scrape") return playwrightScrapeAdapter;
  if (c.parsingStrategy === "ats-api") return ATS_ADAPTERS[c.provider] ?? null;
  return null;
}
