// src/ats/gem.ts — Gem career boards (jobs.gem.com/<slug>), e.g. PromptQL,
// Fireflies, Bolna. The board is a client-rendered SPA (no __NEXT_DATA__ /
// SSR island) that talks to a same-origin, anonymous GraphQL endpoint:
// POST https://jobs.gem.com/api/public/graphql. The `JobBoardList` query
// returns every posting's metadata (locations, department, publish date) in
// one shot — no pagination params, no WAF UA gate — but NOT the description.
// The JD comes from a second query, `ExternalJobPostingQuery`, keyed by the
// board's slug + the posting's opaque `extId`; fetched only for postings that
// survive location + dedup (see AtsAdapter.fetchJd).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, unixToIso } from "./shared.js";

const GEM_ORIGIN = "https://jobs.gem.com";
const GEM_GRAPHQL_URL = `${GEM_ORIGIN}/api/public/graphql`;

const JOB_BOARD_LIST_QUERY = `
  query JobBoardList($boardId: String!) {
    oatsExternalJobPostings(boardId: $boardId) {
      jobPostings {
        id
        extId
        title
        firstPublishedTsSec
        locations {
          id
          extId
          name
          city
          isoCountry
          isRemote
        }
        job {
          id
          department {
            id
            extId
            name
          }
          locationType
          employmentType
        }
      }
    }
  }
`;

const EXTERNAL_JOB_POSTING_QUERY = `
  query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
    oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
      descriptionHtml
    }
  }
`;

export const GemLocationSchema = z.object({
  id: z.union([z.string(), z.number()]),
  extId: z.string(),
  name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  isoCountry: z.string().nullable().optional(),
  isRemote: z.boolean().nullable().optional(),
});
export type GemLocation = z.infer<typeof GemLocationSchema>;

const GemJobMetaSchema = z.object({
  id: z.union([z.string(), z.number()]),
  department: z
    .object({
      id: z.union([z.string(), z.number()]),
      extId: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  locationType: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
});

export const GemJobStubSchema = z.object({
  id: z.union([z.string(), z.number()]),
  extId: z.string(),
  title: z.string(),
  firstPublishedTsSec: z.number().nullable().optional(),
  locations: z.array(GemLocationSchema).nullable().optional(),
  job: GemJobMetaSchema.nullable().optional(),
});
export type GemJobStub = z.infer<typeof GemJobStubSchema>;

const GemJobBoardListSchema = z.object({
  data: z.object({
    oatsExternalJobPostings: z.object({
      jobPostings: z.array(GemJobStubSchema),
    }),
  }),
});

const GemJobDetailSchema = z.object({
  data: z.object({
    oatsExternalJobPosting: z
      .object({
        descriptionHtml: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

// A type alias (not interface): JsonValue callers assignability relies on the
// implicit index signature TS infers for object type literals, which
// interfaces don't get.
export type GemGraphqlRequest = {
  operationName: string;
  variables: Record<string, string>;
  query: string;
};

/** Body for the board's job-list query. Pure — unit tested. */
export function gemListRequestBody(slug: string): GemGraphqlRequest {
  return { operationName: "JobBoardList", variables: { boardId: slug }, query: JOB_BOARD_LIST_QUERY };
}

/** Body for a single posting's description query. Pure — unit tested. */
export function gemJdRequestBody(slug: string, extId: string): GemGraphqlRequest {
  return {
    operationName: "ExternalJobPostingQuery",
    variables: { boardId: slug, extId },
    query: EXTERNAL_JOB_POSTING_QUERY,
  };
}

/** Human-facing board URL for one posting: jobs.gem.com/<slug>/<extId>. */
export function gemJobUrl(slug: string, extId: string): string {
  return `${GEM_ORIGIN}/${slug}/${extId}`;
}

/** Unwrap the `data.oatsExternalJobPostings.jobPostings` envelope. Throws on shape mismatch. */
export function parseGemJobBoardList(json: unknown): GemJobStub[] {
  const parsed = GemJobBoardListSchema.parse(json);
  return parsed.data.oatsExternalJobPostings.jobPostings;
}

/** Unwrap a job-detail response's `descriptionHtml`. Null when the posting was pulled/unlisted. */
export function parseGemJobDetail(json: unknown): string | null {
  const parsed = GemJobDetailSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.data.oatsExternalJobPosting?.descriptionHtml ?? null;
}

export function normalizeGem(company: AdapterCompany, j: GemJobStub): NormalizedPosting {
  const locations = j.locations ?? [];
  const names = locations.map((l) => l.name ?? l.city).filter((n): n is string => !!n);
  const location = names.length > 0 ? names.join("; ") : null;
  const anyLocationRemote = locations.some((l) => l.isRemote === true);
  const locationType = j.job?.locationType ?? "";

  return {
    provider: "gem",
    externalId: j.extId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: gemJobUrl(company.slug, j.extId),
    location,
    isRemote: anyLocationRemote || REMOTE_RE.test(`${locationType} ${location ?? ""}`),
    jdText: "",
    postedAt: unixToIso(j.firstPublishedTsSec ?? null),
  };
}

export const gemAdapter: AtsAdapter = {
  provider: "gem",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(GEM_GRAPHQL_URL, {
      method: "POST",
      body: gemListRequestBody(company.slug),
      provider: "gem",
    });

    let jobPostings: GemJobStub[];
    try {
      jobPostings = parseGemJobBoardList(raw);
    } catch (err) {
      logger.warn({ slug: company.slug, err: String(err) }, "gem list schema mismatch");
      throw new Error(`gem: unexpected JobBoardList response shape for ${company.slug}`);
    }

    return jobPostings.map((j) => normalizeGem(company, j));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(GEM_GRAPHQL_URL, {
      method: "POST",
      body: gemJdRequestBody(company.slug, posting.externalId),
      provider: "gem",
    });
    const descriptionHtml = parseGemJobDetail(raw);
    return htmlToText(descriptionHtml ?? "");
  },
};
