import { z } from "zod";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";
import type { CandidateLink } from "../scraper/cheerio.js";

const ShortlistItemSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
});

const ShortlistResultSchema = z.object({
  jobs: z.array(ShortlistItemSchema),
});

export type ShortlistItem = z.infer<typeof ShortlistItemSchema>;

export interface RunShortlistInput {
  companyName: string;
  candidates: CandidateLink[];
}

const MAX_CANDIDATES = 60;

function formatLinksList(candidates: CandidateLink[]): string {
  return candidates
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => `${i + 1}. ${c.url}  ·  ${c.text}`)
    .join("\n");
}

const TextJobSchema = z.object({
  title: z.string().min(1),
  location: z.string().nullable().optional(),
});
const TextResultSchema = z.object({ jobs: z.array(TextJobSchema) });
export type TextJob = z.infer<typeof TextJobSchema>;

const MAX_TEXT_CHARS = 18_000;

export interface RunShortlistFromTextInput {
  companyName: string;
  bodyText: string;
}

// Phrases the LLM sometimes returns as "titles" even after the prompt tells it
// not to — last-line defense against prompt-following slips.
const NAV_TITLE_RE = /^(apply( now| for this job)?|save( job)?|share|view (all|details|role|job)|browse (jobs|openings|all)|see (more|all|jobs)|sort by|all filters|skip to content|loading|next|previous|page \d+|home|back|menu|search|sign in|log ?in)$/i;
const NON_LOCATION_RE = /^(full[ -]?time|part[ -]?time|contract|temporary|intern(ship)?|permanent|hybrid|on[- ]?site|new|featured|posted .*ago|\d+ days? ago)$/i;

function postProcessTextJobs(jobs: TextJob[]): TextJob[] {
  const seen = new Set<string>();
  const out: TextJob[] = [];
  for (const j of jobs) {
    const title = (j.title ?? "").trim().replace(/\s+/g, " ");
    if (!title || title.length < 3) continue;
    if (NAV_TITLE_RE.test(title)) continue;

    let location: string | null = null;
    if (j.location != null) {
      const trimmed = j.location.trim().replace(/\s+/g, " ");
      if (trimmed && !NON_LOCATION_RE.test(trimmed)) location = trimmed;
    }

    const key = `${title.toLowerCase()}|${location?.toLowerCase() ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ title, location });
  }
  return out;
}

/**
 * Extract job postings directly from rendered body text. For SPAs that don't
 * expose jobs as <a> anchors (Eightfold, iCIMS, custom Angular apps).
 */
export async function runShortlistFromText(input: RunShortlistFromTextInput): Promise<TextJob[]> {
  const text = input.bodyText.slice(0, MAX_TEXT_CHARS);
  if (text.trim().length < 100) return [];

  const prompt = render(config.prompts.shortlistFromText, {
    companyName: input.companyName,
    text,
  });
  const raw = await generate(prompt, { format: "json" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 400) }, "shortlistFromText JSON.parse failed");
    throw new Error(`shortlistFromText output not JSON: ${err}`);
  }
  const result = TextResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 400), issues: result.error.issues.slice(0, 3) },
      "shortlistFromText schema validation failed",
    );
    throw new Error("shortlistFromText output failed schema");
  }
  return postProcessTextJobs(result.data.jobs);
}

/**
 * Pick which cheerio-scraped links are actual job postings. Returns only URLs
 * that appeared in the input (guards against hallucinated URLs).
 */
export async function runShortlist(input: RunShortlistInput): Promise<ShortlistItem[]> {
  if (input.candidates.length === 0) return [];

  if (input.candidates.length > MAX_CANDIDATES) {
    logger.warn(
      { company: input.companyName, total: input.candidates.length, capped: MAX_CANDIDATES },
      "shortlist: candidate list above cap; trimming",
    );
  }

  const prompt = render(config.prompts.shortlist, {
    companyName: input.companyName,
    linksList: formatLinksList(input.candidates),
  });

  const raw = await generate(prompt, { format: "json" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500) }, "shortlist JSON.parse failed");
    throw new Error(`shortlist output not JSON: ${err}`);
  }

  const result = ShortlistResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 500), issues: result.error.issues.slice(0, 3) },
      "shortlist schema validation failed",
    );
    throw new Error("shortlist output failed schema validation");
  }

  const allowed = new Set(input.candidates.map((c) => c.url));
  return result.data.jobs.filter((j) => allowed.has(j.url));
}
