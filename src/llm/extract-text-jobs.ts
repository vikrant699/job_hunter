import { z } from "zod";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";

/** Per-element tolerant shape for body-text job items. */
export const TextJobSchema = z.object({
  title: z.string().optional(),
  location: z.string().nullable().optional(),
});
type ParsedTextJob = z.infer<typeof TextJobSchema>;

export interface TextJob {
  title: string;
  location: string | null;
}

export interface RunShortlistFromTextInput {
  companyName: string;
  bodyText: string;
}

/** Tolerant top-level shape — only fails when there's no `jobs` array at all. */
const JobsArraySchema = z.object({ jobs: z.array(z.unknown()) });

// Phrases the LLM sometimes returns as "titles" even after the prompt tells it
// not to — last-line defense against prompt-following slips.
export const NAV_TITLE_RE = /^(apply( now| for this job)?|save( job)?|share|view (all|details|role|job)|browse (jobs|openings|all)|see (more|all|jobs)|sort by|all filters|skip to content|loading|next|previous|page \d+|home|back|menu|search|sign in|log ?in)$/i;
export const NON_LOCATION_RE = /^(full[ -]?time|part[ -]?time|contract|temporary|intern(ship)?|permanent|hybrid|on[- ]?site|new|featured|posted .*ago|\d+ days? ago)$/i;

export function postProcessTextJobs(jobs: ParsedTextJob[]): TextJob[] {
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

/** Per-item tolerant selection for body-text jobs: a single malformed item never
 *  discards the batch; empty/nav/duplicate titles are stripped by post-processing. */
export function selectTextJobs(rawJobs: unknown[]): TextJob[] {
  const items: ParsedTextJob[] = [];
  for (const item of rawJobs) {
    const r = TextJobSchema.safeParse(item);
    if (r.success) items.push(r.data);
  }
  return postProcessTextJobs(items);
}

/**
 * Extract job postings directly from rendered body text. For SPAs that don't
 * expose jobs as <a> anchors (Eightfold, iCIMS, custom Angular apps).
 */
export async function runShortlistFromText(input: RunShortlistFromTextInput): Promise<TextJob[]> {
  const text = input.bodyText.slice(0, config.llm.jdMaxChars);
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
  const result = JobsArraySchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 400), issues: result.error.issues.slice(0, 3) },
      "shortlistFromText schema validation failed",
    );
    throw new Error("shortlistFromText output failed schema");
  }
  return selectTextJobs(result.data.jobs);
}
