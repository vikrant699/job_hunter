import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";

// Lever public postings: GET api.lever.co/v0/postings/<slug>?mode=json
// Response is a flat array, not wrapped in a `postings` key.
const LeverPostingSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string().url(),
  applyUrl: z.string().url().nullable().optional(),
  createdAt: z.number().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  categories: z
    .object({
      location: z.string().nullable().optional(),
      team: z.string().nullable().optional(),
      department: z.string().nullable().optional(),
      commitment: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  workplaceType: z.string().nullable().optional(),
});
type LeverPosting = z.infer<typeof LeverPostingSchema>;

const REMOTE_HINT_RE = /\b(remote|anywhere|work from home|wfh)\b/i;

export const leverAdapter: AtsAdapter = {
  provider: "lever",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = company.slug;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);

    let raw: unknown;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" },
        signal: controller.signal,
      });
      if (res.status === 404) {
        throw new Error(`lever board not found: ${slug}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`lever HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      raw = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (!Array.isArray(raw)) {
      throw new Error(`lever response for ${slug} was not an array`);
    }

    const out: NormalizedPosting[] = [];
    for (const item of raw) {
      const parsed = LeverPostingSchema.safeParse(item);
      if (!parsed.success) {
        logger.debug({ slug, issues: parsed.error.issues.slice(0, 2) }, "lever item schema skip");
        continue;
      }
      out.push(normalize(company, parsed.data));
    }
    return out;
  },
};

function normalize(company: AdapterCompany, j: LeverPosting): NormalizedPosting {
  const location = j.categories?.location ?? null;
  const workplace = j.workplaceType ?? "";
  const isRemote =
    workplace.toLowerCase() === "remote" ||
    (location ? REMOTE_HINT_RE.test(location) : false);

  const jdRaw = j.descriptionPlain ?? j.description ?? "";
  const jdText = j.descriptionPlain ? jdRaw : htmlToText(jdRaw);

  return {
    provider: "lever",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.text,
    jobUrl: j.hostedUrl,
    location,
    isRemote,
    jdText,
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  };
}
