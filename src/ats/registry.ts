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
import { teamtailorAdapter } from "./teamtailor.js";
import { comeetAdapter } from "./comeet.js";
import { pyjamahrAdapter } from "./pyjamahr.js";
import { goodfitAdapter } from "./goodfit.js";
import { superworksAdapter } from "./superworks.js";
import { recruiterflowAdapter } from "./recruiterflow.js";
import { sfunifyAdapter } from "./sfunify.js";
import { appleAdapter } from "./apple.js";
import { mercedesAdapter } from "./mercedes.js";
import { snapdealAdapter } from "./snapdeal.js";
import { sonyresearchAdapter } from "./sonyresearch.js";
import { peerlistAdapter } from "./peerlist.js";
import { mediatekAdapter } from "./mediatek.js";
import { redbusAdapter } from "./redbus.js";
import { sageAdapter } from "./sage.js";
import { onecardAdapter } from "./onecard.js";
import { moglixAdapter } from "./moglix.js";
import { talent500Adapter } from "./talent500.js";
import { ripplingAdapter } from "./rippling.js";
import { talentsoftAdapter } from "./talentsoft.js";
import { nineNineGamesAdapter } from "./nineninegames.js";
import { dronahqAdapter } from "./dronahq.js";
import { advantageclubAdapter } from "./advantageclub.js";
import { digitalRecruitersAdapter } from "./digitalrecruiters.js";
import { feishuAdapter } from "./feishu.js";
import { skimaAdapter } from "./skima.js";
import { htmlboardAdapter } from "./htmlboard.js";
import { nextdataAdapter } from "./nextdata.js";
import { juspayAdapter } from "./juspay.js";
import { amplelogicAdapter } from "./amplelogic.js";
import { bookmyshowAdapter } from "./bookmyshow.js";
import { talviewAdapter } from "./talview.js";
import { skuadAdapter } from "./skuad.js";
import { gullakAdapter } from "./gullak.js";
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
  teamtailor: teamtailorAdapter,
  comeet: comeetAdapter,
  pyjamahr: pyjamahrAdapter,
  goodfit: goodfitAdapter,
  superworks: superworksAdapter,
  recruiterflow: recruiterflowAdapter,
  sfunify: sfunifyAdapter,
  apple: appleAdapter,
  mercedes: mercedesAdapter,
  snapdeal: snapdealAdapter,
  sonyresearch: sonyresearchAdapter,
  peerlist: peerlistAdapter,
  mediatek: mediatekAdapter,
  redbus: redbusAdapter,
  sage: sageAdapter,
  onecard: onecardAdapter,
  moglix: moglixAdapter,
  talent500: talent500Adapter,
  rippling: ripplingAdapter,
  talentsoft: talentsoftAdapter,
  nineninegames: nineNineGamesAdapter,
  dronahq: dronahqAdapter,
  advantageclub: advantageclubAdapter,
  digitalrecruiters: digitalRecruitersAdapter,
  feishu: feishuAdapter,
  skima: skimaAdapter,
  htmlboard: htmlboardAdapter,
  nextdata: nextdataAdapter,
  juspay: juspayAdapter,
  amplelogic: amplelogicAdapter,
  bookmyshow: bookmyshowAdapter,
  talview: talviewAdapter,
  skuad: skuadAdapter,
  gullak: gullakAdapter,
};

export function resolveAdapter(c: Company): AtsAdapter | null {
  if (c.parsingStrategy === "llm-scrape") return llmScrapeAdapter;
  if (c.parsingStrategy === "playwright-llm-scrape") return playwrightScrapeAdapter;
  if (c.parsingStrategy === "ats-api") return ATS_ADAPTERS[c.provider] ?? null;
  return null;
}
