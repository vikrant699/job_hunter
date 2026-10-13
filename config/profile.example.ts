// Copy to config/profile.ts (gitignored) and edit to match your resume, target roles and locations.

import type { UserProfile } from "../src/types.js";
export type { UserProfile };

export const profile: UserProfile = {
  // id: optional, identifies this profile in the shared DB; usually left unset for the default profile.

  // resumeText is NOT set here - put your resume at config/resume.pdf, it is extracted automatically at startup.

  hardDealBreakers: [
    // Conditions that silently reject a posting.
    "Internship / fresher / trainee / 0–1 YOE roles",
    "Roles requiring a MINIMUM of 6 or more years of relevant experience (e.g., 'minimum 6 years', '6+ years', '7 to 10 years'). NOTE: ranges that start below 6 (e.g., '3-5 years', '4+ years') are FINE.",
    "Third-party hiring / staffing / recruitment-agency posts where the role is for an unnamed 'client' or 'partner company'. The actual employer must be visible.",
  ],

  softDealBreakers: [
    // Still matched, but only as yellow.
    "Senior leadership / people-management roles (Lead, Principal, Staff, Head of, Director, VP). NOTE: 'Senior X' titles (e.g., 'Senior Data Analyst') are individual-contributor seniority levels — do NOT flag those.",
    "US-shift / night-shift / non-local-timezone working hours",
  ],

  filters: {
    candidateYoe: 4.5,
    hardYoeCap: 6,
    yoeAcceptUnspecified: false,
    // Must stay above SILENT_SCORE_FLOOR (0.65, see src/filter/verdict.ts) or profile load refuses to start.
    matchThreshold: 0.8,
  },

  location: {
    // India-targeting example - replace with your own cities/countries (lowercase, case-insensitive match).
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
    // Distinctive non-India places, whole-word matched against the TITLE only; curated to avoid India collisions (e.g. "phoenix" is deliberately absent, it's also a Hyderabad tech park).
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

  // Pre-filter regexes that silently drop matching titles before the LLM call; defaults target a data-analyst hunt.
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

  // Companies you never want to see (hard pre-fetch deny); defaults cover the largest services/staffing firms.
  servicesDenylist: {
    slugFragments: [
      "infosys", "tcs", "tata-consultancy", "wipro", "cognizant",
      "accenture", "capgemini", "hcl", "tech-mahindra", "techmahindra",
      "ltimindtree", "lti-", "mindtree", "mphasis", "persistent",
      "coforge", "hexaware", "birlasoft", "ntt-data", "dxc",
      "genpact", "deloitte", "kpmg", "pwc", "pricewaterhousecoopers", "ernst-young",
      "quess", "randstad", "manpower", "teamlease", "antal", "kelly-services",
      "abc-consultants", "michael-page",
      "bhel", "bpcl", "bsnl", "coal-india", "cowin-negd", "digilocker-negd",
      "digital-india-corporation", "drdo", "isro", "hal-aerospace",
      "reserve-bank-information-technology", "hpcl", "india-post-payments-bank",
      "indian-oil-corporation", "nhpc", "nic-india", "ntpc-limited", "ongc",
      "power-grid-corporation", "sjvn", "stpi", "uidai",
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
