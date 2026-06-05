export type Provider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "workable"
  | "oracle"
  | "keka"
  | "eightfold"
  | "phenom"
  | "darwinbox"
  | "custom";

export type ParsingStrategy =
  | "ats-api"
  | "llm-scrape"
  | "playwright-llm-scrape"
  | "manual";

export type CompanyStatus =
  | "active"
  | "candidate"
  | "dormant"
  | "denied"
  | "broken";

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
export interface AdapterCompany {
  provider: Provider;
  slug: string;
  name: string;
  careersUrl: string;
  tenantUrl: string | null;
  apiMeta: Record<string, string> | null;
}

/** Registry entry as stored in JSON (seed or discovery-written working file). */
export interface RegistryEntry {
  name: string;
  careers_url: string;
  source: Provider;
  source_slug?: string | null;
  parsing_strategy: ParsingStrategy;
  status?: CompanyStatus;
  reason?: string;
  discovered_via?: string;
  discovered_at?: string;
  evidence?: string;
  /** Workday tenant URL when source=workday. Ignored otherwise. */
  tenant_url?: string;
  /** Adapter-specific tokens persisted as JSON (keka orgGuid, eightfold domain, oracle siteNumber). */
  api_meta?: Record<string, string>;
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
