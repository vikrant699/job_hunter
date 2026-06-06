import { z } from "zod";

export const ProviderSchema = z.enum([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
  "workable", "oracle", "keka", "eightfold", "phenom", "darwinbox", "custom",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ParsingStrategySchema = z.enum([
  "ats-api", "llm-scrape", "playwright-llm-scrape", "manual",
]);
export type ParsingStrategy = z.infer<typeof ParsingStrategySchema>;

export const CompanyStatusSchema = z.enum([
  "active", "candidate", "dormant", "denied", "broken",
]);
export type CompanyStatus = z.infer<typeof CompanyStatusSchema>;

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
}

/** Subset of Company passed to ATS adapters — strips runtime/stats fields. */
export type AdapterCompany = Pick<Company, "provider" | "slug" | "name" | "careersUrl" | "tenantUrl" | "apiMeta">;

/** Registry entry as stored in JSON (seed or discovery-written working file). */
export const RegistryEntrySchema = z.object({
  name: z.string().min(1),
  careers_url: z.string().url(),
  source: ProviderSchema,
  source_slug: z.string().min(1).nullable().optional(),
  parsing_strategy: ParsingStrategySchema,
  status: CompanyStatusSchema.optional(),
  reason: z.string().optional(),
  discovered_via: z.string().optional(),
  discovered_at: z.string().optional(),
  evidence: z.string().optional(),
  /** Workday tenant URL when source=workday. Ignored otherwise. */
  tenant_url: z.string().url().optional(),
  /** Adapter-specific tokens persisted as JSON (keka orgGuid, eightfold domain, oracle siteNumber). */
  api_meta: z.record(z.string()).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** Everything personal about who you are and what roles you want. */
export interface UserProfile {
  /** Full resume text the relevance gate judges against. NOT set in this module:
   *  it is loaded at startup from config/resume.txt (generated once from
   *  config/resume.pdf). The bot stops if no resume PDF/text is present. */
  resumeText?: string;
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
    /** Country-level hints (e.g. "india", "in,"). Same case-insensitive match. */
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
