// src/ats/onecard.ts — Onecard / FPL Technologies careers (fplabs.tech/careers).
//
// The careers page itself is Sucuri-gated (a bare fetch/curl gets a 307
// interstitial), but it's a plain static page with one inline <script> that
// calls a public onrender-hosted Strapi-style API directly from the browser:
//
//   GET https://ibffpublic6f2461135ffd1b6a80db296ec15abf.onrender.com/hr/jobs
//     ?pagination[page]=<n>&pagination[pageSize]=<size>
//     Header: x-api-key: hr-read-only
//     -> { success: true, data: { data: [{ id, attributes: { title, location,
//          experience, description, publishedAt } }], meta: { pagination:
//          { page, pageSize, pageCount, total } } } }
//
//   The `x-api-key` is STATIC and PUBLIC — it's a literal string baked into
//   the page's inline <script> (captured live via a Playwright network
//   capture of fplabs.tech/careers: the browser's own request carries
//   `x-api-key: hr-read-only|`, and replaying that header with a bare curl/
//   fetch — no browser, no cookies — returns 200 with the same JSON envelope
//   the SPA renders from). Omitting the header (or using a wrong key) gets a
//   500 with `{"success":false,"error":{"message":"Unauthorized"}}`.
//
//   Board had 0 openings at capture time (2026-07-13): `data.data: []`,
//   `meta.pagination.total: 0`. The channel itself is confirmed live and
//   working — this adapter ships to return [] cleanly today and pick up
//   postings the moment Onecard opens a requisition, with no code changes
//   needed. The per-job shape above (including the exact field names) comes
//   straight from the page's own rendering template, since no live job was
//   available to capture as a real fixture.
//
//   The template shows no per-job deep link at all — every "Apply Now"
//   button is the same static `mailto:careers@getonecard.app`, regardless of
//   job. jobUrl is therefore synthesized as the careers page plus a
//   `#job-<id>` anchor (stable, unique per posting, still resolves to the
//   real board) rather than inventing a URL the site doesn't have.
//
// JD: description (and experience) are already inline in the list response
//   (rendered into a bare `<pre>` in the template, i.e. plain text) — no
//   fetchJd needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const API_ORIGIN = "https://ibffpublic6f2461135ffd1b6a80db296ec15abf.onrender.com";
const LIST_PATH = "/hr/jobs";
const API_KEY = "hr-read-only";
const PAGE = 25; // server appears to enforce this regardless of pageSize requested

export const OnecardJobAttributesSchema = z.object({
  title: z.string(),
  location: z.string().nullable().optional(),
  experience: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
});
export type OnecardJobAttributes = z.infer<typeof OnecardJobAttributesSchema>;

export const OnecardJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  attributes: OnecardJobAttributesSchema,
});
export type OnecardJob = z.infer<typeof OnecardJobSchema>;

const OnecardResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(OnecardJobSchema),
    meta: z
      .object({
        pagination: z
          .object({
            page: z.number().nullable().optional(),
            pageSize: z.number().nullable().optional(),
            pageCount: z.number().nullable().optional(),
            total: z.number().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});

export function onecardListUrl(page: number, pageSize: number): string {
  const params = new URLSearchParams({
    "pagination[page]": String(page),
    "pagination[pageSize]": String(pageSize),
  });
  return `${API_ORIGIN}${LIST_PATH}?${params.toString()}`;
}

/** Joins the experience hint ahead of the description; empty when both are absent. */
export function onecardJdText(a: OnecardJobAttributes): string {
  const parts: string[] = [];
  if (a.experience) parts.push(`Experience required: ${a.experience}`);
  if (a.description) parts.push(a.description);
  return parts.join("\n\n");
}

export function normalizeOnecard(company: AdapterCompany, j: OnecardJob): NormalizedPosting {
  const location = j.attributes.location ?? null;
  return {
    provider: "onecard",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.attributes.title,
    // No per-job deep link exists on the site (every apply CTA is the same
    // mailto:) — anchor into the board page instead of inventing one.
    jobUrl: `${company.careersUrl.replace(/\/+$/, "")}/#job-${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: onecardJdText(j.attributes),
    postedAt: dateToIso(j.attributes.publishedAt),
  };
}

export const onecardAdapter: AtsAdapter = {
  provider: "onecard",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await paginate<OnecardJob>({
      provider: "onecard",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(onecardListUrl(page + 1, PAGE), {
          provider: "onecard",
          headers: { "x-api-key": API_KEY },
        });
        const parsed = parseOrThrow(OnecardResponseSchema, json, { provider: "onecard", slug: company.slug });
        return {
          items: parsed.data.data,
          total: parsed.data.meta?.pagination?.total ?? null,
        };
      },
    });
    return raw.map((j) => normalizeOnecard(company, j));
  },
};
