import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, parsePostedOn, paginate } from "./shared.js";
import { discoverIndiaFacet } from "./workday-facet.js";

// Workday CXS adapter. Per-tenant URLs like apple.wd1.myworkdayjobs.com/External.
// Two-phase: listPostings (metadata only) then fetchJd (full body) so we only
// pay the per-job HTTP call for postings that survived location + dedup.
interface WorkdayUrlParts {
  base: string;
  tenant: string;
  site: string;
  cxsBase: string;
  uiBase: string;
}

function parseTenantUrl(tenantUrl: string): WorkdayUrlParts {
  const u = new URL(tenantUrl);
  const tenant = u.host.split(".")[0];
  if (!tenant) throw new Error(`workday tenant URL missing tenant segment: ${tenantUrl}`);
  const site = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/")[0];
  if (!site) throw new Error(`workday tenant URL missing site segment: ${tenantUrl}`);
  const base = `${u.protocol}//${u.host}`;
  return {
    base,
    tenant,
    site,
    cxsBase: `${base}/wday/cxs/${tenant}/${site}`,
    uiBase: `${base}/en-US/${site}`,
  };
}

const WorkdayJobPostingSchema = z.object({
  title: z.string(),
  externalPath: z.string(),
  locationsText: z.string().nullable().optional(),
  postedOn: z.string().nullable().optional(),
  bulletFields: z.array(z.string()).nullable().optional(),
  jobPostingId: z.string().nullable().optional(),
  shortId: z.string().nullable().optional(),
});
type WorkdayJobPosting = z.infer<typeof WorkdayJobPostingSchema>;

const WorkdayListResponseSchema = z.object({
  total: z.number().nullable().optional(),
  jobPostings: z.array(WorkdayJobPostingSchema),
});

const WorkdayJobDetailSchema = z.object({
  jobPostingInfo: z.object({
    jobDescription: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    locationsText: z.string().nullable().optional(),
    postedOn: z.string().nullable().optional(),
    timeType: z.string().nullable().optional(),
    remoteType: z.string().nullable().optional(),
  }),
});

const PAGE_LIMIT = 20;

export const workdayAdapter: AtsAdapter = {
  provider: "workday",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);
    const listUrl = `${parts.cxsBase}/jobs`;

    // Probe for an India country facet. Most tenants expose it; legacy ones may
    // not — in that case we paginate unfiltered (bounded by the pagination cap
    // below) and the downstream location filter handles India detection from
    // the locationsText.
    const indiaFacet = await discoverIndiaFacet(parts);
    const appliedFacets: Record<string, string[]> = indiaFacet
      ? { [indiaFacet.param]: [indiaFacet.uuid] }
      : {};
    if (!indiaFacet) {
      logger.warn(
        { company: company.slug },
        "workday: no India country facet found; fetching unfiltered (slower)"
      );
    } else {
      logger.debug(
        { company: company.slug, param: indiaFacet.param },
        "workday: applying India country facet"
      );
    }

    // Caterpillar (and some others) report `total` correctly only on the
    // first page; `paginate` latches the first non-zero value it sees and
    // uses it to terminate even when later pages keep returning PAGE_LIMIT
    // jobs past the real end.
    return paginate<NormalizedPosting>({
      provider: "workday",
      company: company.slug,
      pageSize: PAGE_LIMIT,
      fetchPage: async (offset) => {
        const data = await atsFetchJson(listUrl, {
          method: "POST",
          body: { appliedFacets, limit: PAGE_LIMIT, offset, searchText: "" },
          provider: "workday",
        });

        const parsed = WorkdayListResponseSchema.safeParse(data);
        if (!parsed.success) {
          logger.warn(
            { company: company.slug, issues: parsed.error.issues.slice(0, 2) },
            "workday list schema mismatch"
          );
          throw new Error(`workday list response failed schema for ${company.slug}`);
        }

        const items = parsed.data.jobPostings.map((j) => normalizeListing(company, parts, j));
        const total = typeof parsed.data.total === "number" && parsed.data.total > 0 ? parsed.data.total : null;
        return { items, total };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    if (!company.tenantUrl) {
      throw new Error(`workday adapter requires tenant_url for ${company.slug}`);
    }
    const parts = parseTenantUrl(company.tenantUrl);

    // externalPath is stored in the posting's job-detail URL; we squirreled the path
    // into jobUrl during normalizeListing. Reconstruct the CXS detail endpoint.
    const externalPath = extractExternalPathFromJobUrl(posting.jobUrl, parts.uiBase);
    if (!externalPath) {
      throw new Error(`cannot derive externalPath from jobUrl: ${posting.jobUrl}`);
    }
    const detailUrl = `${parts.cxsBase}${externalPath}`;

    const raw = await atsFetchJson(detailUrl, { provider: "workday" });

    const parsed = WorkdayJobDetailSchema.safeParse(raw);
    if (!parsed.success) {
      logger.debug(
        { company: company.slug, externalId: posting.externalId, issues: parsed.error.issues.slice(0, 2) },
        "workday detail schema mismatch"
      );
      return "";
    }
    return htmlToText(parsed.data.jobPostingInfo.jobDescription ?? "");
  },
};

function normalizeListing(
  company: AdapterCompany,
  parts: WorkdayUrlParts,
  j: WorkdayJobPosting
): NormalizedPosting {
  // externalId: prefer shortId/jobPostingId, fall back to externalPath tail.
  // bulletFields is display metadata ("Full time", "40 hrs/week") — never an ID;
  // using it would collide every posting on tenants that omit shortId.
  const externalId =
    j.shortId ??
    j.jobPostingId ??
    j.externalPath.split("/").pop() ??
    j.externalPath;

  const location = j.locationsText ?? null;
  const isRemote = location ? REMOTE_RE.test(location) : false;

  return {
    provider: "workday",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    // jobUrl is the human-facing UI URL — useful for Discord links AND we use it
    // to reconstruct externalPath in fetchJd.
    jobUrl: `${parts.uiBase}${j.externalPath}`,
    location,
    isRemote,
    jdText: "",
    postedAt: parsePostedOn(j.postedOn ?? null),
  };
}

function extractExternalPathFromJobUrl(jobUrl: string, uiBase: string): string | null {
  if (!jobUrl.startsWith(uiBase)) return null;
  const path = jobUrl.slice(uiBase.length);
  return path.length > 0 ? path : null;
}
