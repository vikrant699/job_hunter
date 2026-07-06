import type { Provider, ParsingStrategy, CompanyStatus } from "./schemas.js";

/** A company in the registry (mirrors the `companies` DB table). */
export interface Company {
  provider: Provider;
  slug: string;
  name: string;
  careersUrl: string;
  parsingStrategy: ParsingStrategy;
  status: CompanyStatus;
  denyReason: string | null;
  discoveredVia: string | null;
  /** Adapter-specific URL. For Workday: full tenant URL e.g.
   *  "https://apple.wd1.myworkdayjobs.com/External". Null otherwise. */
  tenantUrl: string | null;
  /** Adapter-specific tokens (Keka orgGuid, Eightfold domain, Oracle siteNumber). Null otherwise. */
  apiMeta: Record<string, string> | null;
  discoveredAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  postingsSeenTotal: number;
  postingsMatchedTotal: number;
  /** Consecutive clean fetches that saw 0 raw postings (dormancy input). */
  zeroYieldStreak: number;
  /** Page fetched OK but doesn't look like a careers page — url-repair target. */
  urlSuspect: boolean;
}

/** Subset of Company passed to ATS adapters — strips runtime/stats fields. */
export type AdapterCompany = Pick<Company, "provider" | "slug" | "name" | "careersUrl" | "tenantUrl" | "apiMeta">;

// Runtime validator for this shape lives in schemas.ts (UserProfileSchema); keep them in sync.
/** Everything personal about who you are and what roles you want. */
export interface UserProfile {
  /** Stable per-profile id — stamped onto every posting/run row. Defaults to
   *  "default"; set by the loader from --profile, NOT hand-edited here. */
  id?: string;
  /** Discord webhook for THIS profile's notifications. Falls back to
   *  process.env.DISCORD_WEBHOOK_URL when unset. */
  webhookUrl?: string;
  /** Per-profile relevance-gate prompt template (same {{placeholders}} as the
   *  default in src/llm/prompts/gate.ts: resume, hardDealBreakers,
   *  softDealBreakers, jobTitle, companyName, jdText). Lets a profile screen for
   *  a different role family (e.g. frontend engineer vs data analyst). Falls
   *  back to the global default when unset. */
  gatePrompt?: string;
  /** Full resume text the relevance gate judges against. NOT set in this module:
   *  it is loaded at startup from config/resume.txt (generated once from
   *  config/resume.pdf). The bot stops if no resume PDF/text is present. */
  resumeText?: string;
  /** Free-text pitch inserted into the outreach email template
   *  ({{profile_pitch}}). Omit for no pitch paragraph. */
  profilePitch?: string;
  /** Display name used in outreach email subjects/signatures. Falls back to
   *  the profile id ({@link UserProfile.id}) when unset. */
  senderName?: string;
  /** Links appended to the outreach email signature (portfolio, LinkedIn,
   *  GitHub, etc). Joined with " | " on one line; omit for none. */
  senderLinks?: string[];
  hardDealBreakers: string[];
  softDealBreakers: string[];
  filters: {
    /** Your current years of experience (can be fractional, e.g. 4.5). */
    candidateYoe: number;
    /** Postings whose minimum-required YOE is >= this get SILENTLY dropped.
     *  Set higher than your YOE — 1.0 to 1.5 above is a sensible default. */
    hardYoeCap: number;
    /** When the JD doesn't state a YOE, do we accept (true) or yellow-flag (false)? */
    yoeAcceptUnspecified: boolean;
    /** Match score above which a posting goes green (vs yellow). 0..1 scale. */
    matchThreshold: number;
  };
  location: {
    /** Substrings (case-insensitive) of cities/regions you want to target. */
    targetCities: string[];
    /** Country-level hints (e.g. "india", "in,"). Same case-insensitive search. */
    targetCountryHints: string[];
    /** Phrases that mean "remote from <your region>" — accepted as in-region. */
    remoteAcceptStrings: string[];
    /** Phrases that mean "out of region only" — reject even if a target city appears. */
    rejectIfPresent: string[];
    /** Distinctive out-of-region place names (foreign cities/states/countries),
     *  matched as whole words against a posting's TITLE. Catches scraped postings
     *  that carry the location in the title (e.g. "Data Scientist — Sydney, NSW")
     *  while a foreign HQ named only in the JD body still won't reject. */
    rejectRegions?: string[];
  };
  /** Cheap regex pre-filter on job titles. A match means "skip before LLM call". */
  titleDenyPatterns: readonly RegExp[];
  /** Title patterns that must NEVER be silently dropped. When a posting's title
   *  matches one of these and its score is below the silent floor — but it is NOT
   *  a hard deal-breaker and NOT over the hard YOE cap — it is floored to yellow so
   *  it always surfaces for review. For a rare sub-specialty worth eyeballing even
   *  at a borderline score (e.g. React Native for a frontend engineer). */
  neverSilenceTitlePatterns?: readonly RegExp[];
  servicesDenylist: {
    /** Slug fragments — if the company slug contains any of these, deny. */
    slugFragments: string[];
    /** Regex patterns — if the company name matches any of these, deny. */
    namePatterns: readonly RegExp[];
  };
}

/** Normalized job posting — shared shape across all parsing strategies. */
export interface NormalizedPosting {
  provider: Provider;
  /** Stable per-provider ID. Combined with provider, forms the dedup PK. */
  externalId: string;
  companySlug: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  /** Raw location string from the provider (used for in-region filter). */
  location: string | null;
  /** Set true when provider explicitly tags posting as remote. */
  isRemote: boolean;
  /** Plain-text JD. HTML stripped before this point. */
  jdText: string;
  postedAt: string | null;
}
