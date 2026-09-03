// src/ats/onecard.ts — Onecard / FPL Technologies careers (fplabs.tech/careers): the Sucuri-gated page's own inline <script> calls a public onrender-hosted Strapi-style API directly.
// GET .../hr/jobs?pagination[page]=<n>&pagination[pageSize]=<size>, header x-api-key: hr-read-only (a static public literal, no browser/cookies needed).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const API_ORIGIN = "https://ibffpublic6f2461135ffd1b6a80db296ec15abf.onrender.com";
const LIST_PATH = "/hr/jobs";
const API_KEY = "hr-read-only";
const PAGE = 25; // server appears to enforce this regardless of pageSize requested

// Board had 0 openings at build time; the per-job field shape is inferred from the page's rendering template rather than a live fixture.
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
    // No per-job deep link exists (every apply CTA is the same mailto:), so jobUrl is synthesized as the careers page plus a `#job-<id>` anchor.
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
