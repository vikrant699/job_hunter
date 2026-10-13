import { z } from "zod";
import type { UserProfile } from "./types.js";

/** Below this the gate score is noise and the posting is silently dropped. Lives here to avoid a profile.ts<->verdict.ts cycle. */
export const SILENT_SCORE_FLOOR = 0.65;

export const ProviderSchema = z.enum([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
  "workable", "oracle", "keka", "eightfold", "eightfoldpcs", "phenom", "darwinbox", "greythr", "jibe",
  "zohorecruit", "successfactors", "peoplestrong",
  "ainterviews", "recruitee", "freshteam", "gohire", "jobsoid", "ceipal",
  "ripplehire", "zwayam", "sensehq", "breezyhr",
  "turbohire", "avature", "jazzhr", "jobvite", "webbtree", "zappyhire", "talentrecruit", "trakstar",
  "sharechat", "amazonjobs", "wpjobs", "mynexthire", "metacareers",
  "gem", "dover", "ycombinator", "icicibank", "reliance", "magicpin", "tatacareers",
  "peoplehum", "leapscholar", "bamboohr", "setu", "radancy", "atlassian", "kula", "urbancompany",
  "happyeasygo", "adityabirla", "teamtailor", "comeet", "pyjamahr", "goodfit",
  "superworks", "recruiterflow", "sfunify", "apple", "mercedes",
  "snapdeal", "sonyresearch", "peerlist", "mediatek", "redbus",
  "sage", "onecard", "moglix", "talent500", "rippling", "talentsoft", "nineninegames", "dronahq", "advantageclub", "digitalrecruiters", "feishu", "skima", "htmlboard", "nextdata", "jsvar",
  "juspay", "amplelogic", "talview", "skuad", "gullak", "ongig", "directemployers", "procmart", "superops", "bmw", "ubs", "reliancebrands", "ralphlauren", "paramai", "spire2grow", "bajajauto", "ujjivan", "consider",
  "happyfox",
  "qwikbuild", "savein", "reczee",
  "ibm",
  "manappuram",
  "lohum", "squareyards", "talentzq", "zwayam-public", "pinpoint", "talentfunnel", "brassring", "sfcsb", "hdfclife", "icims", "cvviz", "google", "jio", "sirion", "unberry", "recrew", "jsonld", "custom",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ParsingStrategySchema = z.enum([
  "ats-api", "llm-scrape", "playwright-llm-scrape", "manual",
]);
export type ParsingStrategy = z.infer<typeof ParsingStrategySchema>;

export const CompanyStatusSchema = z.enum([
  "active", "dormant", "denied", "broken",
]);
export type CompanyStatus = z.infer<typeof CompanyStatusSchema>;

/** GLOBAL, not per-profile: a verified or bounced contact holds across every profile. */
export const RecruiterStatusSchema = z.enum(["unverified", "verified", "bounced"]);
export type RecruiterStatus = z.infer<typeof RecruiterStatusSchema>;

export const RecruiterSourceSchema = z.enum(["raw-csv", "manual-sheet"]);
export type RecruiterSource = z.infer<typeof RecruiterSourceSchema>;

export const OutreachStatusSchema = z.enum(["draft", "discarded", "sent", "bounced", "verified"]);
export type OutreachStatus = z.infer<typeof OutreachStatusSchema>;

export const UndraftedReasonSchema = z.enum([
  "no_contact", "cooldown", "bounced_contact", "draft_discarded",
]);
export type UndraftedReason = z.infer<typeof UndraftedReasonSchema>;

/** drop_stage NULL -> green, 'yellow' -> yellow. */
export const SeveritySchema = z.enum(["green", "yellow"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ApiMetaSchema = z.record(z.string(), z.string());

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
  tenant_url: z.string().url().optional(),
  api_meta: ApiMetaSchema.optional(),
  category: z.string().optional(),
  employer_type: z.enum(["product", "service"]).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const UserProfileSchema = z.object({
  id: z.string().optional(),
  gatePrompt: z.string().optional(),
  resumeText: z.string().optional(),
  profilePitch: z.string().optional(),
  senderName: z.string().optional(),
  senderLinks: z.array(z.string()).optional(),
  hardDealBreakers: z.array(z.string()),
  softDealBreakers: z.array(z.string()),
  filters: z.object({
    candidateYoe: z.number(),
    hardYoeCap: z.number(),
    yoeAcceptUnspecified: z.boolean(),
    matchThreshold: z.number(),
    silentFloor: z.number().optional(),
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
}) satisfies z.ZodType<UserProfile>;
