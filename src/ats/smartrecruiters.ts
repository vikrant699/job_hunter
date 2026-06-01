import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";

// SmartRecruiters public Posting API.
//   list:   GET api.smartrecruiters.com/v1/companies/<slug>/postings (paginated)
//   detail: GET api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
// Two-phase like Workday so fetchJd only runs for new in-region postings.

const PAGE_LIMIT = 100;
const INTER_PAGE_DELAY_MS = 150;
const PAGE_WARN_INTERVAL = 100;

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

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": config.fetch.userAgent,
      Accept: "application/json",
    },
    signal,
  });
  if (res.status === 404) throw new Error(`smartrecruiters 404: ${url}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`smartrecruiters HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export const smartRecruitersAdapter: AtsAdapter = {
  provider: "smartrecruiters",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = company.slug;
    const out: NormalizedPosting[] = [];
    let offset = 0;

    for (let page = 0; ; page++) {
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${PAGE_LIMIT}&offset=${offset}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
      let raw: unknown;
      try {
        raw = await getJson(url, controller.signal);
      } finally {
        clearTimeout(timer);
      }

      const parsed = ListResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn(
          { slug, issues: parsed.error.issues.slice(0, 2) },
          "smartrecruiters list schema mismatch"
        );
        throw new Error(`smartrecruiters list response failed schema for ${slug}`);
      }

      for (const p of parsed.data.content) {
        out.push(normalize(company, p));
      }

      if (parsed.data.content.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
      if ((page + 1) % PAGE_WARN_INTERVAL === 0) {
        logger.warn(
          { slug, pages: page + 1, jobsSoFar: out.length },
          "smartrecruiters pagination still going — unusually large company"
        );
      }
      if (INTER_PAGE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
    }

    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.slug)}/postings/${encodeURIComponent(posting.externalId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
    let raw: unknown;
    try {
      raw = await getJson(url, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    const parsed = DetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.debug(
        { slug: company.slug, externalId: posting.externalId, issues: parsed.error.issues.slice(0, 2) },
        "smartrecruiters detail schema mismatch"
      );
      return "";
    }

    // Replace the synthesized list-time URL with the canonical one from the API.
    posting.jobUrl = srPostingUrl(company.slug, posting.externalId, parsed.data);

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
  detail?: { postingUrl?: string | null; applyUrl?: string | null },
): string {
  const fromApi = detail?.postingUrl ?? detail?.applyUrl;
  if (fromApi) return fromApi;
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;
}

function normalize(company: AdapterCompany, p: Posting): NormalizedPosting {
  // Build "City, Region, Country" with country upper-cased — SR returns
  // lower-case country codes (e.g. "in") which the location filter expects.
  const loc = p.location;
  const parts: string[] = [];
  if (loc?.city) parts.push(loc.city);
  if (loc?.region) parts.push(loc.region);
  if (loc?.country) parts.push(loc.country.toUpperCase());
  const location = parts.length > 0 ? parts.join(", ") : null;
  const isRemote = loc?.remote === true;

  const jobUrl = srPostingUrl(company.slug, p.id);

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
