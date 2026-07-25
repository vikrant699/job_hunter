// src/ats/procmart.ts — ProcMart careers (www.procmart.com). Each opening is
// a generic WordPress PAGE (not a custom post type) at slug `job-opening-<N>`;
// the careers landing page just links to them. So:
//
//   list: GET /wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link,title
//         -> keep pages whose slug matches /^job-opening-\d+$/
//   jd:   GET /wp-json/wp/v2/pages/<id>?_fields=id,slug,link,title,content
//         -> content.rendered is raw Elementor HTML; the real job title is
//            the first <h2> text (page.title.rendered is always "Job
//            Opening"), and the JD is the rest of that HTML.
//
// Verified live (2026-07-18, plain curl): 3 openings, all India (Gurugram/
// Noida). New openings appear as new numbered pages, so the listing is
// re-derived each run rather than assuming a contiguous id range.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { tenantOrigin } from "./shared.js";

const JOB_SLUG_RE = /^job-opening-\d+$/;
const FIXED_LOCATION = "India";

export const ProcmartPageSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string(),
  link: z.string().nullable().optional(),
  content: z.object({ rendered: z.string().nullable().optional() }).nullable().optional(),
});
const ProcmartListSchema = z.array(ProcmartPageSchema);

/** Title = first <h2> text in the Elementor content; null if none. */
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
    const raw = await atsFetchJson(
      `${base}/wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link,content`,
      { provider: "procmart" },
    );
    const parsed = parseOrThrow(ProcmartListSchema, raw, { provider: "procmart", slug: company.slug, what: "pages" });

    const out: NormalizedPosting[] = [];
    for (const page of parsed) {
      if (!JOB_SLUG_RE.test(page.slug)) continue;
      const html = page.content?.rendered ?? "";
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
