import type { Provider, ParsingStrategy, CompanyStatus } from "./schemas.js";

export interface Company {
  provider: Provider;
  slug: string;
  name: string;
  careersUrl: string;
  parsingStrategy: ParsingStrategy;
  status: CompanyStatus;
  denyReason: string | null;
  discoveredVia: string | null;
  tenantUrl: string | null;
  apiMeta: Record<string, string> | null;
  discoveredAt: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  postingsSeenTotal: number;
  postingsMatchedTotal: number;
  zeroYieldStreak: number;
  urlSuspect: boolean;
}

export type AdapterCompany = Pick<Company, "provider" | "slug" | "name" | "careersUrl" | "tenantUrl" | "apiMeta">;

export interface UserProfile {
  id?: string | undefined;
  gatePrompt?: string | undefined;
  resumeText?: string | undefined;
  profilePitch?: string | undefined;
  senderName?: string | undefined;
  senderLinks?: string[] | undefined;
  hardDealBreakers: string[];
  softDealBreakers: string[];
  filters: {
    candidateYoe: number;
    hardYoeCap: number;
    yoeAcceptUnspecified: boolean;
    matchThreshold: number;
    silentFloor?: number | undefined;
  };
  location: {
    targetCities: string[];
    targetCountryHints: string[];
    remoteAcceptStrings: string[];
    rejectIfPresent: string[];
    rejectRegions?: string[] | undefined;
  };
  titleDenyPatterns: readonly RegExp[];
  neverSilenceTitlePatterns?: readonly RegExp[] | undefined;
  servicesDenylist: {
    slugFragments: string[];
    namePatterns: readonly RegExp[];
  };
}

export interface NormalizedPosting {
  provider: Provider;
  externalId: string;
  companySlug: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  location: string | null;
  isRemote: boolean;
  jdText: string;
  postedAt: string | null;
}
