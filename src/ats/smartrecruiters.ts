import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { paginate, joinLocation } from "./shared.js";

// SmartRecruiters public Posting API.
//   list:   GET api.smartrecruiters.com/v1/companies/<slug>/postings (paginated)
//   detail: GET api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
// Two-phase like Workday so fetchJd only runs for new in-region postings.

const PAGE_LIMIT = 100;

/** SmartRecruiters company token for the API. Defaults to the registry slug;
 *  apiMeta.boardSlug overrides it when the registry slug isn't the SR company
 *  id (e.g. coding-ninjas -> "CodingNinjas", indegene -> "Indegene1"). */
function srToken(company: AdapterCompany): string {
  return company.apiMeta?.boardSlug ?? company.slug;
}

const LocationSchema = z.object({
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
});

const PostingSchema = z.object({
  id: z.string(),
  name: z.string(),
  releasedDate: z.string().nullable().optional(),
  createdOn: z.string().nullable().optional(),
  location: LocationSchema.nullable().optional(),
  ref: z.string().nullable().optional(),
});
type Posting = z.infer<typeof PostingSchema>;

const ListResponseSchema = z.object({
  totalFound: z.number().nullable().optional(),
  offset: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  content: z.array(PostingSchema),
});

const SectionSchema = z.object({
  title: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
});

const DetailResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  postingUrl: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: SectionSchema.nullable().optional(),
          jobDescription: SectionSchema.nullable().optional(),
          qualifications: SectionSchema.nullable().optional(),
          additionalInformation: SectionSchema.nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export const smartRecruitersAdapter: AtsAdapter = {
  provider: "smartrecruiters",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = srToken(company);

    return paginate<NormalizedPosting>({
      provider: "smartrecruiters",
      company: slug,
      pageSize: PAGE_LIMIT,
      fetchPage: async (offset) => {
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${PAGE_LIMIT}&offset=${offset}`;

        const raw = await atsFetchJson(url, { provider: "smartrecruiters" });

        const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "smartrecruiters", slug });

        const items = parsed.content.map((p) => normalize(company, p));
        // total-based stop was added during the paginate() migration — this tenant
        // previously relied on short-page detection only, `totalFound` went unused.
        const total = typeof parsed.totalFound === "number" ? parsed.totalFound : null;
        return { items, total };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(srToken(company))}/postings/${encodeURIComponent(posting.externalId)}`;

    const raw = await atsFetchJson(url, { provider: "smartrecruiters" });

    const parsed = DetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.debug(
        { slug: company.slug, externalId: posting.externalId, issues: parsed.error.issues.slice(0, 2) },
        "smartrecruiters detail schema mismatch"
      );
      return "";
    }

    // Replace the synthesized list-time URL with the canonical one from the API.
    posting.jobUrl = srPostingUrl(srToken(company), posting.externalId, parsed.data);

    const sections = parsed.data.jobAd?.sections;
    if (!sections) return "";
    const parts = [
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);
    return htmlToText(parts.join("\n\n"));
  },
};

/**
 * The human-facing posting URL. SmartRecruiters exposes the canonical URL only on
 * the detail endpoint (postingUrl / applyUrl); the list endpoint carries just an
 * API self-link. When neither is available we synthesize a jobs.smartrecruiters.com
 * URL — the correct host (the old careers.smartrecruiters.com form did not resolve
 * for tenants with their own front-end, e.g. Bosch).
 */
export function srPostingUrl(
  slug: string,
  id: string,
  detail?: { postingUrl?: string | null | undefined; applyUrl?: string | null | undefined },
): string {
  const fromApi = detail?.postingUrl ?? detail?.applyUrl;
  if (fromApi && /^https?:\/\//i.test(fromApi)) return fromApi;
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
}

function normalize(company: AdapterCompany, p: Posting): NormalizedPosting {
  // Build "City, Region, Country" with country upper-cased — SR returns
  // lower-case country codes (e.g. "in") which the location filter expects.
  const loc = p.location;
  const location = joinLocation(loc?.city, loc?.region, loc?.country?.toUpperCase());
  const isRemote = loc?.remote === true;

  const jobUrl = srPostingUrl(srToken(company), p.id);

  return {
    provider: "smartrecruiters",
    externalId: p.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.name,
    jobUrl,
    location,
    isRemote,
    jdText: "",
    postedAt: p.releasedDate ?? p.createdOn ?? null,
  };
}
