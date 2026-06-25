import { z } from "zod";

export const ProviderSchema = z.enum([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
  "workable", "oracle", "keka", "eightfold", "phenom", "darwinbox", "greythr", "custom",
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
  /** Sector taxonomy (Phase 3 categorization, 2026-06-19). Curated; reporting + gate domain context. */
  category: z.string().optional(),
  /** product (kept) vs service (staffing/consultancy/IT-services — excluded). */
  employer_type: z.enum(["product", "service"]).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

// Documented hand-edited contract is the UserProfile interface in types.ts; keep in sync.
export const UserProfileSchema = z.object({
  id: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  gatePrompt: z.string().optional(),
  resumeText: z.string().optional(),
  hardDealBreakers: z.array(z.string()),
  softDealBreakers: z.array(z.string()),
  filters: z.object({
    candidateYoe: z.number(),
    hardYoeCap: z.number(),
    yoeAcceptUnspecified: z.boolean(),
    matchThreshold: z.number(),
  }),
  location: z.object({
    targetCities: z.array(z.string()),
    targetCountryHints: z.array(z.string()),
    remoteAcceptStrings: z.array(z.string()),
    rejectIfPresent: z.array(z.string()),
    rejectRegions: z.array(z.string()).optional(),
  }),
  titleDenyPatterns: z.array(z.instanceof(RegExp)).readonly(),
  neverSilenceTitlePatterns: z.array(z.instanceof(RegExp)).readonly().optional(),
  servicesDenylist: z.object({
    slugFragments: z.array(z.string()),
    namePatterns: z.array(z.instanceof(RegExp)).readonly(),
  }),
});
