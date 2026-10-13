// list: GET platform.qwikbuild.com/api/apps/v1/<apiMeta.appId>/server/data/public/openings?page=N (1-based, 20/page, {data[], total}); job page = <careers_url>/<slug>
// jd: GET .../public/openings/<slug> -> data.jobDescription (HTML); a closed role answers 410
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrNull, parseOrThrow } from "./http.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE, joinLocation, paginate } from "./shared.js";

const PAGE_SIZE = 20;

const QwikbuildOpeningSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  location: z.string().nullable().optional(),
  workMode: z.string().nullable().optional(),
});

type QwikbuildOpening = z.infer<typeof QwikbuildOpeningSchema>;

const QwikbuildPageSchema = z.object({
  data: z.array(QwikbuildOpeningSchema),
  total: z.number().nullable().optional(),
});

const QwikbuildDetailSchema = z.object({
  data: z.object({ jobDescription: z.string().nullable().optional() }),
});

function openingsBase(company: AdapterCompany): string {
  const appId = company.apiMeta?.appId;
  if (!appId) throw new Error(`qwikbuild adapter requires apiMeta.appId for ${company.slug}`);
  return `https://platform.qwikbuild.com/api/apps/v1/${encodeURIComponent(appId)}/server/data/public/openings`;
}

export function qwikbuildOpeningsUrl(company: AdapterCompany, page: number): string {
  return `${openingsBase(company)}?page=${page}`;
}

export function qwikbuildJobUrl(company: AdapterCompany, slug: string): string {
  return `${company.careersUrl.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

export const qwikbuildAdapter: AtsAdapter = {
  provider: "qwikbuild",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const country = company.apiMeta?.country;
    const openings = await paginate<QwikbuildOpening>({
      provider: "qwikbuild",
      company: company.slug,
      pageSize: PAGE_SIZE,
      dedupeBy: (o) => o.slug,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(qwikbuildOpeningsUrl(company, page + 1), { provider: "qwikbuild" });
        const parsed = parseOrThrow(QwikbuildPageSchema, raw, { provider: "qwikbuild", slug: company.slug });
        return { items: parsed.data, total: parsed.total ?? null };
      },
    });
    return openings.map((o) => {
      const place = o.location?.trim() || null;
      return {
        provider: "qwikbuild",
        externalId: o.slug,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: o.title.trim(),
        jobUrl: qwikbuildJobUrl(company, o.slug),
        location: place && country && !place.toLowerCase().includes(country.toLowerCase()) ? joinLocation(place, country) : place,
        isRemote: REMOTE_RE.test(`${place ?? ""} ${o.workMode ?? ""}`),
        jdText: "",
        postedAt: null,
      };
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(`${openingsBase(company)}/${encodeURIComponent(posting.externalId)}`, { provider: "qwikbuild" });
    const parsed = parseOrNull(QwikbuildDetailSchema, raw, { provider: "qwikbuild", slug: company.slug });
    return parsed ? htmlToText(parsed.data.jobDescription ?? "") : "";
  },
};
