// list: GET jobs.cvviz.com/api/career/employers/<employerId>/jobs?page=&pageSize= -> {data[], total} (NOT api.cvviz.com, which is token-gated)
// employerId must be the NUMERIC careerpage id, not the slug (slug form 200s intermittently with "Invalid employer id")
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const HOST = "https://jobs.cvviz.com";
const PAGE = 25; // the API rejects large page sizes; 25 is honored.

export const CvvizJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  jobdescription: z.string().nullable().optional(),
});
export type CvvizJob = z.infer<typeof CvvizJobSchema>;

const ListResponseSchema = z.object({
  data: z.array(CvvizJobSchema),
  total: z.number().nullable().optional(),
});

export function cvvizEmployerId(company: AdapterCompany): string {
  const id = company.apiMeta?.employerId;
  if (!id) throw new Error(`cvviz requires apiMeta.employerId (numeric careerpage id) for ${company.slug}`);
  return id;
}

/** Display-only slug for building human job URLs (not used for the API call itself). */
export function cvvizDisplaySlug(company: AdapterCompany): string {
  const url = company.tenantUrl ?? company.careersUrl;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (seg) return seg;
  } catch {
    /* fall through */
  }
  return company.slug;
}

export function cvvizJobsUrl(employerId: string, page: number, pageSize: number): string {
  return `${HOST}/api/career/employers/${encodeURIComponent(employerId)}/jobs?page=${page}&pageSize=${pageSize}`;
}

/** City, state, country joined; blanks skipped; null when all empty. */
export function cvvizLocation(j: Pick<CvvizJob, "city" | "state" | "country">): string | null {
  return joinLocation(j.city ?? undefined, j.state ?? undefined, j.country ?? undefined);
}

export function normalizeCvviz(company: AdapterCompany, j: CvvizJob): NormalizedPosting {
  const location = cvvizLocation(j);
  return {
    provider: "cvviz",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${HOST}/${cvvizDisplaySlug(company)}/job/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.jobdescription ?? ""),
    postedAt: null, // the list API exposes no posting date
  };
}

export interface CvvizPage {
  postings: NormalizedPosting[];
  total: number | null;
}

export function parseCvvizPage(company: AdapterCompany, raw: JsonValue): CvvizPage {
  const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "cvviz", slug: company.slug });
  return {
    postings: parsed.data.map((j) => normalizeCvviz(company, j)),
    total: typeof parsed.total === "number" ? parsed.total : null,
  };
}

export const cvvizAdapter: AtsAdapter = {
  provider: "cvviz",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const employerId = cvvizEmployerId(company);
    return paginate<NormalizedPosting>({
      provider: "cvviz",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(cvvizJobsUrl(employerId, page + 1, PAGE), { provider: "cvviz" });
        const { postings, total } = parseCvvizPage(company, raw);
        return { items: postings, total };
      },
    });
  },
  // jobdescription is inline in the list response — no fetchJd needed.
};
