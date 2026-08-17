// src/ats/procmart.ts — ProcMart careers (www.procmart.com). Each opening is
// a generic WordPress PAGE (not a custom post type) at slug `job-opening-<N>`;
// the careers landing page just links to them.
//
// The origin has a server-side bug (surfaced 2026-08-03, root-caused
// 2026-08-17): ANY /wp-json/wp/v2/pages COLLECTION query whose `_fields`
// includes `content` never answers (503 or a 20s+ stall — the Elementor render
// of some page hangs PHP), while the same collection without content answers in
// ~0.3s and SINGLE-page content fetches answer in ~0.5s each. The one-call
// list-with-content this adapter used until then is exactly the broken query,
// so the flow is now two-phase:
//
//   list:   GET /wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link
//           -> keep pages whose slug matches /^job-opening-\d+$/  (no content!)
//   detail: GET /wp-json/wp/v2/pages/<id>?_fields=id,slug,link,content
//           -> content.rendered is raw Elementor HTML; the real job title is
//              the first <h2> text (page.title.rendered is always "Job
//              Opening"), and the JD is the rest of that HTML.
//
// Verified live (2026-08-17, plain curl): 3 openings, all India (Gurugram/
// Noida). New openings appear as new numbered pages, so the listing is
// re-derived each run rather than assuming a contiguous id range.
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
    // Deliberately WITHOUT the content field — see file header, that query hangs
    // the origin. Content comes from one cheap per-page fetch per opening below.
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
