/**
 * User profile — everything personal about who you are and what roles you want.
 *
 * Setup:
 *   1. Copy this file to `config/profile.ts`
 *   2. Edit the fields below to match your resume, target roles, and locations
 *   3. `config/profile.ts` is gitignored — your edits stay local
 *
 * Field-by-field guide:
 *   - hardDealBreakers    Conditions that SILENTLY reject a posting (no Discord ping)
 *   - softDealBreakers    Conditions that still notify, but with a yellow warning
 *   - filters             YOE bounds + the green/yellow score thresholds
 *   - location            Which locations count as in-region or acceptable remote
 *   - titleDenyPatterns   Cheap regex pre-filter that drops obvious non-fits before
 *                         the LLM call (saves time and Ollama load).
 *                         Conservative — false positives mean missed roles.
 *   - servicesDenylist    Companies you never want to see (e.g. staffing agencies)
 */

import type { UserProfile } from "../src/types.js";
export type { UserProfile };

export const profile: UserProfile = {
  // Optional. Identifies this profile in the shared DB and picks its Discord
  // webhook. Usually left unset for the default profile; named profiles live in
  // config/profiles/<name>/profile.ts and the loader sets `id` from the dir name.
  // webhookUrl: "https://discord.com/api/webhooks/...",

  // resumeText is NOT set here. Put your resume at config/resume.pdf; it is
  // extracted to config/resume.txt and loaded at startup (see src/profile.ts).

  hardDealBreakers: [
    // Things you ABSOLUTELY do not want to see — these silently reject a posting.
    "Internship / fresher / trainee / 0–1 YOE roles",
    "Roles requiring a MINIMUM of 6 or more years of relevant experience (e.g., 'minimum 6 years', '6+ years', '7 to 10 years'). NOTE: ranges that start below 6 (e.g., '3-5 years', '4+ years') are FINE.",
    "Third-party hiring / staffing / recruitment-agency posts where the role is for an unnamed 'client' or 'partner company'. The actual employer must be visible.",
  ],

  softDealBreakers: [
    // Things you'd PROBABLY skip but still want to see flagged for review.
    "Senior leadership / people-management roles (Lead, Principal, Staff, Head of, Director, VP). NOTE: 'Senior X' titles (e.g., 'Senior Data Analyst') are individual-contributor seniority levels — do NOT flag those.",
    "US-shift / night-shift / non-local-timezone working hours",
  ],

  filters: {
    candidateYoe: 4.5,
    hardYoeCap: 6,
    yoeAcceptUnspecified: false,
    matchThreshold: 0.6,
  },

  location: {
    // Edit for your region. Below is an India-targeting example — replace with
    // your own cities/countries. Lowercase strings, matched against the posting's
    // location field (case-insensitive).
    targetCities: [
      "bangalore", "bengaluru", "blr",
      "mumbai",
      "hyderabad",
      "pune",
      "delhi", "new delhi", "ncr", "gurgaon", "gurugram", "noida",
      "chennai",
      "kolkata",
      "ahmedabad",
      "visakhapatnam", "vizag",
    ],
    targetCountryHints: ["india", "in,"],
    remoteAcceptStrings: [
      "remote - india", "remote, india", "remote (india)",
      "india remote", "remote india",
    ],
    rejectIfPresent: [
      "remote - united states", "remote - us", "remote, us",
      "us only", "us-only", "usa only",
      "uk only", "eu only", "europe only",
    ],
    // Distinctive non-India places. Whole-word match against the TITLE, so these
    // catch title-embedded foreign locations without false-rejecting an India role
    // whose JD merely mentions a foreign HQ. Curated to avoid India collisions
    // (e.g. "phoenix" is intentionally absent — it appears in a Hyderabad tech park).
    rejectRegions: [
      "sydney", "melbourne", "brisbane", "perth", "canberra", "nsw", "vic", "auckland", "wellington",
      "new york", "san francisco", "seattle", "chicago", "los angeles", "boston", "austin",
      "denver", "dallas", "houston", "atlanta", "tempe", "palo alto", "mountain view", "sunnyvale", "san jose",
      "london", "manchester", "dublin", "paris", "berlin", "munich", "amsterdam", "madrid", "barcelona", "zurich", "stockholm",
      "singapore", "kuala lumpur", "jakarta", "manila", "bangkok", "hong kong", "shanghai", "beijing", "shenzhen", "tokyo", "seoul",
      "dubai", "abu dhabi", "tel aviv", "riyadh",
      "toronto", "vancouver", "montreal", "mexico city", "sao paulo", "buenos aires",
      "united states", "u.s.a", "australia", "new zealand", "united kingdom", "germany", "france",
      "netherlands", "canada", "ireland", "brazil", "japan", "philippines",
    ],
  },

  // Pre-filter regex patterns. Each pattern fires BEFORE the LLM call and silently
  // drops postings whose titles match. Adjust for your target role family.
  //
  // The defaults below target a data-analyst job hunt — they drop pure SWE,
  // SRE/DevOps, QA, design, and hardware-engineering postings. If you are a
  // software engineer, REMOVE these defaults and add patterns targeting roles
  // you don't want (e.g. analyst, sales, marketing).
  titleDenyPatterns: [
    /\b(?:senior |staff |principal |lead |sr\.? |junior |jr\.? )?(?:backend|back[- ]end|frontend|front[- ]end|fullstack|full[- ]stack|full stack|mobile|ios|android|embedded|firmware|hardware|kernel|graphics|game|3d|blockchain|web3|crypto)\s+(?:software\s+)?(?:engineer|engineering|developer|dev|programmer)\b/i,
    /\b(?:senior |staff |principal |lead |sr\.? |junior |jr\.? )?(?:software|application|applications|product)\s+(?:engineer|engineering|developer|dev|programmer)\b/i,
    /\b(?:senior |staff |principal |lead |sr\.? )?s[wd]e\b(?:[- ]*(?:[ivx]+|\d+))?/i,
    /\b(?:sre|site reliability|devops|dev[- ]ops|platform|cloud|infrastructure|network|systems?)\s+(?:engineer|engineering|architect)\b/i,
    /\b(?:security|cybersecurity|cyber[- ]security|infosec|application security|app sec|appsec)\s+(?:engineer|engineering|architect|developer)\b/i,
    /\b(?:qa|test|test automation|sdet|quality assurance)\s+(?:engineer|engineering|automation engineer|developer)\b/i,
    /\b(?:ux|ui|product|graphic|visual|interaction|motion)\s+designer\b/i,
    /\b(?:asic|fpga|verification|silicon|rtl|analog|digital design|pcb|mechanical|electrical|electronics)\s+(?:engineer|engineering|designer)\b/i,
  ],

  // Companies you never want to see — used as a hard pre-fetch deny. The defaults
  // below cover the largest services / staffing firms. Add or remove freely.
  servicesDenylist: {
    slugFragments: [
      "infosys", "tcs", "tata-consultancy", "wipro", "cognizant",
      "accenture", "capgemini", "hcl", "tech-mahindra", "techmahindra",
      "ltimindtree", "lti-", "mindtree", "mphasis", "persistent",
      "coforge", "hexaware", "birlasoft", "ntt-data", "dxc",
      "genpact", "deloitte", "kpmg", "pwc", "pricewaterhousecoopers", "ernst-young",
      "quess", "randstad", "manpower", "teamlease", "antal", "kelly-services",
      "abc-consultants", "michael-page",
      // Indian gov / PSU
      "bhel", "bpcl", "bsnl", "coal-india", "cowin-negd", "digilocker-negd",
      "digital-india-corporation", "drdo", "isro", "hal-aerospace",
      "reserve-bank-information-technology", "hpcl", "india-post-payments-bank",
      "indian-oil-corporation", "nhpc", "nic-india", "ntpc-limited", "ongc",
      "power-grid-corporation", "sjvn", "stpi", "uidai",
      // Eternal-owned (Zomato Ltd. rebrand, 2025)
      "zomato", "blinkit", "hyperpure",
      // referral-only / no public hiring
      "zerodha",
    ],
    namePatterns: [
      /\b(consulting|consultants|consultancy|services|solutions)\b/i,
      /\b(staffing|recruit|recruitment|recruiter|talent)\b/i,
      /\bBhabha Atomic\b/i,
      /^BARC(\s|$)/,
      /^HAL(\s|$)/,
    ],
  },
};
