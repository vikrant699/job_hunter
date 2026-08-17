// src/ats/procmart.ts — ProcMart careers (www.procmart.com). Each opening is a WordPress PAGE at
// slug `job-opening-<N>`. The origin hangs on any /wp-json/wp/v2/pages COLLECTION query whose
// `_fields` includes `content` (Elementor render stalls PHP), so this is two-phase: list without
// content, then fetch each page's content individually. page.title.rendered is always "Job Opening",
// so the real title is the content's first <h2>.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { tenantOrigin } from "./shared.js";

const JOB_SLUG_RE = /^job-opening-\d+$/;
const FIXED_LOCATION = "India";

const ProcmartListItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string(),
  link: z.string().nullable().optional(),
});
const ProcmartListSchema = z.array(ProcmartListItemSchema);

export const ProcmartPageSchema = ProcmartListItemSchema.extend({
  content: z.object({ rendered: z.string().nullable().optional() }).nullable().optional(),
});

export function procmartTitle(html: string): string | null {
  const m = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (!m?.[1]) return null;
  const t = htmlToText(m[1]).trim();
  return t || null;
}

export const procmartAdapter: AtsAdapter = {
  provider: "procmart",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = tenantOrigin(company);
    // Deliberately without the content field — see file header, that query hangs the origin.
    const raw = await atsFetchJson(
      `${base}/wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link`,
      { provider: "procmart" },
    );
    const parsed = parseOrThrow(ProcmartListSchema, raw, { provider: "procmart", slug: company.slug, what: "pages" });
    const jobPages = parsed.filter((page) => JOB_SLUG_RE.test(page.slug));

    const out: NormalizedPosting[] = [];
    for (const page of jobPages) {
      const rawDetail = await atsFetchJson(
        `${base}/wp-json/wp/v2/pages/${page.id}?_fields=id,slug,link,content`,
        { provider: "procmart" },
      );
      const detail = parseOrThrow(ProcmartPageSchema, rawDetail, {
        provider: "procmart",
        slug: company.slug,
        what: "page detail",
      });
      const html = detail.content?.rendered ?? "";
      const title = procmartTitle(html);
      if (!title) continue;
      out.push({
        provider: "procmart",
        externalId: String(page.id),
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: title,
        jobUrl: page.link ?? `${base}/${page.slug}/`,
        location: FIXED_LOCATION,
        isRemote: false,
        jdText: htmlToText(html),
        postedAt: null,
      });
    }
    return out;
  },
};
