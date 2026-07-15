import { z } from "zod";

/**
 * Lower bound below which we treat the gate's match score as noise and silently
 * drop the posting (see classifyVerdict in filter/verdict.ts). Lives here (a
 * neutral, import-free module) rather than in verdict.ts so profile.ts can
 * validate `filters.matchThreshold` against it at load time without creating a
 * profile.ts <-> verdict.ts import cycle (verdict.ts imports profile.ts for
 * filter config). verdict.ts re-exports this constant for back-compat.
 */
export const SILENT_SCORE_FLOOR = 0.65;

export const ProviderSchema = z.enum([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
  "workable", "oracle", "keka", "eightfold", "eightfoldpcs", "phenom", "darwinbox", "greythr", "jibe",
  "zohorecruit", "successfactors", "peoplestrong",
  "ainterviews", "recruitee", "freshteam", "gohire", "jobsoid", "ceipal",
  "ripplehire", "zwayam", "sensehq", "breezyhr",
  "turbohire", "avature", "jazzhr", "webbtree", "zappyhire", "talentrecruit", "trakstar",
  "sharechat", "amazonjobs", "wpjobs", "mynexthire", "metacareers",
  "gem", "dover", "ycombinator", "icicibank", "reliance", "magicpin", "tatacareers",
  "peoplehum", "leapscholar", "bamboohr", "setu", "radancy", "atlassian", "kula", "urbancompany",
  "happyeasygo", "adityabirla", "teamtailor", "comeet", "pyjamahr", "goodfit",
  "superworks", "recruiterflow", "sfunify", "apple", "mercedes",
  "snapdeal", "sonyresearch", "peerlist", "mediatek", "redbus",
  "sage", "onecard", "moglix", "talent500", "rippling", "talentsoft", "nineninegames", "dronahq", "advantageclub", "custom",
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

/** Recruiter verification status. GLOBAL (not per-profile): once a contact is
 *  verified or bounces, that holds across every profile that might reach out. */
export const RecruiterStatusSchema = z.enum(["unverified", "verified", "bounced"]);
export type RecruiterStatus = z.infer<typeof RecruiterStatusSchema>;

/** Recruiter row provenance. */
export const RecruiterSourceSchema = z.enum(["raw-csv", "manual-sheet"]);
export type RecruiterSource = z.infer<typeof RecruiterSourceSchema>;

/** Lifecycle of an outreach attempt (one Gmail draft to one recruiter). */
export const OutreachStatusSchema = z.enum(["draft", "discarded", "sent", "bounced", "verified"]);
export type OutreachStatus = z.infer<typeof OutreachStatusSchema>;

/** Why a matched posting did NOT get a draft. */
export const UndraftedReasonSchema = z.enum([
  "no_contact", "cooldown", "bounced_contact", "draft_discarded",
]);
export type UndraftedReason = z.infer<typeof UndraftedReasonSchema>;

/** Outreach-relevant posting severity (the only two tiers a notified posting
 *  can carry: drop_stage NULL -> green, drop_stage 'yellow' -> yellow). */
export const SeveritySchema = z.enum(["green", "yellow"]);
export type Severity = z.infer<typeof SeveritySchema>;

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
  gatePrompt: z.string().optional(),
  resumeText: z.string().optional(),
  /** Free-text pitch inserted into the outreach email template. Optional. */
  profilePitch: z.string().optional(),
  /** Display name for outreach email signatures. Falls back to the profile id when unset. */
  senderName: z.string().optional(),
  /** Links appended to the outreach email signature (portfolio, LinkedIn, etc). */
  senderLinks: z.array(z.string()).optional(),
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
