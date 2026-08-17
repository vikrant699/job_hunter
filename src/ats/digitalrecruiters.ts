// src/ats/digitalrecruiters.ts — Digital Recruiters (api.digitalrecruiters.com), shared multi-tenant French ATS
// (Decathlon and other EU employers), keyed by careers-site domain (apiMeta.domainName). No auth, no CSRF.
// List: POST /public/v1/careers-site/job-ads (JD not inline). JD: GET .../job-ads/<id> (description+profile HTML).
// Public job URL is https://<domain>/<localePath>/<jobPathSlug>/<url>; those fields are cached in apiMeta.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const API = "https://api.digitalrecruiters.com/public/v1/careers-site/job-ads";
const PAGE = 100;

export interface DigitalRecruitersMeta {
  domainName: string;
  /** API locale (e.g. "en_GB"). Default "en_GB". */
  locale: string;
  /** URL path locale segment (e.g. "en"). Default "en". */
  localePath: string;
  /** Tenant's jobs-listing route slug (config jobs_link). Default "annonces". */
  jobPathSlug: string;
}

function meta(company: AdapterCompany): DigitalRecruitersMeta {
  const domainName = company.apiMeta?.domainName;
  if (!domainName) {
    throw new Error(`digitalrecruiters adapter requires apiMeta.domainName for ${company.slug}`);
  }
  return {
    domainName,
    locale: company.apiMeta?.locale ?? "en_GB",
    localePath: company.apiMeta?.localePath ?? "en",
    jobPathSlug: company.apiMeta?.jobPathSlug ?? "annonces",
  };
}

const ListItemSchema = z.object({
  job_ad_id: z.union([z.number(), z.string()]),
  title: z.string(),
  location: z.string().nullable().optional(),
  contract: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});
export type DrListItem = z.infer<typeof ListItemSchema>;
const ListResponseSchema = z.object({
  count: z.number().nullable().optional(),
  items: z.array(ListItemSchema),
});

const DetailBodySchema = z.object({
  description: z.string().nullable().optional(),
  profile: z.string().nullable().optional(),
});
// Root usually carries description/profile directly; tolerate an {item:{...}}
// envelope as a fallback.
const DetailResponseSchema = DetailBodySchema.extend({
  item: DetailBodySchema.optional(),
});

export function normalizeDigitalRecruiters(company: AdapterCompany, m: DigitalRecruitersMeta, j: DrListItem): NormalizedPosting {
  const location = j.location ?? null;
  const slug = j.url ?? String(j.job_ad_id);
  return {
    provider: "digitalrecruiters",
    externalId: String(j.job_ad_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `https://${m.domainName}/${m.localePath}/${m.jobPathSlug}/${slug}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "", // fetched lazily via fetchJd
    postedAt: null, // list omits the publish date; detail has it but we don't need it here
  };
}

export const digitalRecruitersAdapter: AtsAdapter = {
  provider: "digitalrecruiters",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const m = meta(company);
    return paginate<NormalizedPosting>({
      provider: "digitalrecruiters",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const url = `${API}?domainName=${encodeURIComponent(m.domainName)}&limit=${PAGE}&page=${page + 1}&locale=${encodeURIComponent(m.locale)}`;
        const raw = await atsFetchJson(url, { method: "POST", body: {}, provider: "digitalrecruiters" });
        const parsed = parseOrThrow(ListResponseSchema, raw, {
          provider: "digitalrecruiters",
          slug: company.slug,
          what: `list page ${page}`,
        });
        return {
          items: parsed.items.map((j) => normalizeDigitalRecruiters(company, m, j)),
          total: parsed.count ?? null,
        };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const m = meta(company);
    const url = `${API}/${encodeURIComponent(posting.externalId)}?domainName=${encodeURIComponent(m.domainName)}&locale=${encodeURIComponent(m.locale)}`;
    const raw = await atsFetchJson(url, { provider: "digitalrecruiters" });
    const parsed = parseOrNull(DetailResponseSchema, raw, { provider: "digitalrecruiters", slug: company.slug });
    if (!parsed) return "";
    // Fall back to the {item:{...}} envelope only when the root carries neither field.
    const d = (parsed.description || parsed.profile) ? parsed : (parsed.item ?? parsed);
    return htmlToText([d.description ?? "", d.profile ?? ""].filter(Boolean).join("\n\n"));
  },
};
