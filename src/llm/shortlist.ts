import { z } from "zod";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";
import type { CandidateLink } from "../scraper/cheerio.js";
import { parseJsonOrThrow } from "../util/json.js";

const ShortlistItemSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

/** Tolerant top-level shape — only fails when there's no `jobs` array at all.
 *  Items are validated per-element so one bad entry can't discard the whole batch. */
const JobsArraySchema = z.object({ jobs: z.array(z.unknown()) });

export interface ShortlistItem {
  url: string;
  title: string;
}

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

/** Per-item tolerant selection for cheerio link candidates: drops malformed items
 *  and hallucinated URLs (not in the candidate set), fills an empty title from the
 *  anchor text, and de-dupes by URL — so one bad item can't lose the whole company. */
export function selectShortlistItems(rawJobs: unknown[], candidates: CandidateLink[]): ShortlistItem[] {
  const anchorByUrl = new Map(
    candidates.map((c) => [c.url, (c.text ?? "").trim().replace(/\s+/g, " ")]),
  );
  const seen = new Set<string>();
  const out: ShortlistItem[] = [];
  for (const item of rawJobs) {
    const r = ShortlistItemSchema.safeParse(item);
    if (!r.success) continue;
    const url = r.data.url;
    if (!anchorByUrl.has(url) || seen.has(url)) continue;
    let title = (r.data.title ?? "").trim().replace(/\s+/g, " ");
    if (!title) title = anchorByUrl.get(url) ?? "";
    if (!title) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
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

  const parsed = parseJsonOrThrow(raw, "shortlist");

  const result = JobsArraySchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 500), issues: result.error.issues.slice(0, 3) },
      "shortlist schema validation failed",
    );
    throw new Error("shortlist output failed schema validation");
  }

  return selectShortlistItems(result.data.jobs, input.candidates);
}
