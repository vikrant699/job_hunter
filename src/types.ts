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
  /** Adapter-specific URL, e.g. full Workday tenant URL. Null otherwise. */
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
  /** Page fetched OK but doesn't look like a careers page — surfaced by scripts/registryHealth.ts for manual repair. */
  urlSuspect: boolean;
}

/** Subset of Company passed to ATS adapters — strips runtime/stats fields. */
export type AdapterCompany = Pick<Company, "provider" | "slug" | "name" | "careersUrl" | "tenantUrl" | "apiMeta">;

// Runtime validator for this shape lives in schemas.ts (UserProfileSchema); compile-enforced by the satisfies clause in schemas.ts.
/** Everything personal about who you are and what roles you want. */
export interface UserProfile {
  /** Stable per-profile id, stamped onto every posting/run row. Set by the loader from --profile. */
  id?: string | undefined;
  /** Per-profile relevance-gate prompt template; lets a profile screen for a different role family. Falls back to the global default. */
  gatePrompt?: string | undefined;
  /** Loaded at startup from config/resume.txt (generated from config/resume.pdf); the bot stops if absent. */
  resumeText?: string | undefined;
  /** Free-text pitch inserted into the outreach email template ({{profile_pitch}}). */
  profilePitch?: string | undefined;
  /** Display name for outreach email subjects/signatures. Falls back to the profile id when unset. */
  senderName?: string | undefined;
  /** Links appended to the outreach email signature, joined with " | ". */
  senderLinks?: string[] | undefined;
  hardDealBreakers: string[];
  softDealBreakers: string[];
  filters: {
    /** Your current years of experience (can be fractional, e.g. 4.5). */
    candidateYoe: number;
    /** Postings whose minimum-required YOE is >= this get silently dropped. Set 1.0-1.5 above your YOE. */
    hardYoeCap: number;
    /** When the JD doesn't state a YOE, do we accept (true) or yellow-flag (false)? */
    yoeAcceptUnspecified: boolean;
    /** Match score above which a posting goes green (vs yellow). 0..1 scale. */
    matchThreshold: number;
    /** Override of the silent-drop floor (defaults to SILENT_SCORE_FLOOR); must stay below matchThreshold so a yellow band exists. */
    silentFloor?: number | undefined;
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
    /** Foreign place names matched as whole words against a posting's title only (a foreign HQ named only in the JD body won't reject). */
    rejectRegions?: string[] | undefined;
  };
  /** Cheap regex pre-filter on job titles. A match means "skip before LLM call". */
  titleDenyPatterns: readonly RegExp[];
  /** Title matches here are floored to yellow instead of silently dropped (unless a hard deal-breaker or over the YOE cap). */
  neverSilenceTitlePatterns?: readonly RegExp[] | undefined;
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
