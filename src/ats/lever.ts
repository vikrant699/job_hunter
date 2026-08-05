import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

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
  // Lever splits the body across these: lists[] holds the responsibilities /
  // requirements bullets (where skills like SQL live), additional(Plain) is the
  // closing section. The adapter must include them or it only sees the intro.
  lists: z
    .array(z.object({ text: z.string().nullable().optional(), content: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  additionalPlain: z.string().nullable().optional(),
  additional: z.string().nullable().optional(),
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

export const leverAdapter: AtsAdapter = {
  provider: "lever",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = company.slug;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;

    const raw = await atsFetchJson(url, { provider: "lever" });

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
    (location ? REMOTE_RE.test(location) : false);

  // Assemble the WHOLE posting: intro + every list section + closing. Lever
  // keeps the responsibilities/requirements (and thus the real skill signal)
  // in lists[]/additionalPlain, not descriptionPlain — see schema note above.
  const intro = j.descriptionPlain ?? (j.description ? htmlToText(j.description) : "");
  const listText = (j.lists ?? [])
    .map((l) => `${l.text ?? ""}\n${l.content ? htmlToText(l.content) : ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  const closing = j.additionalPlain ?? (j.additional ? htmlToText(j.additional) : "");
  const jdText = [intro, listText, closing].filter(Boolean).join("\n\n").trim();

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
