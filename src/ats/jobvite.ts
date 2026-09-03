// list: GET .../search/?p=<N> (0-based) -> table.jv-job-list rows
// jd: GET .../job/<id> -> .jv-job-detail-description; .jv-job-detail-meta is department + locations
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml } from "./http.js";
import { REMOTE_RE, paginate, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

const ORIGIN = "https://jobs.jobvite.com";
// Placeholder the list renders for multi-site postings ("2 Locations").
const LOCATION_PLACEHOLDER_RE = /^\d+\s+Locations?$/i;

export interface JobviteJob {
  id: string;
  title: string;
  location: string;
}

/** Tenant token from the board URL (jobs.jobvite.com/<tenant>/...). */
export function jobviteTenant(company: AdapterCompany): string {
  for (const url of [company.tenantUrl, company.careersUrl]) {
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== "jobs.jobvite.com") continue;
    const seg = u.pathname.split("/").find((s) => s !== "");
    if (seg !== undefined && seg !== "search" && seg !== "job") return seg;
  }
  throw new Error(`jobvite: no jobs.jobvite.com board URL for ${company.slug}`);
}

/** Paged search URL (0-based; the trailing slash is load-bearing — the slash-less path ignores ?p= and always serves page 0). */
export function jobviteSearchUrl(tenant: string, page: number): string {
  return `${ORIGIN}/${encodeURIComponent(tenant)}/search/?p=${page}`;
}

/** Parse one search page: rows + the "1-50 of 53" total (null when the board fits one page, no pagination control). */
export function parseJobviteList(html: string): { jobs: JobviteJob[]; total: number | null } {
  const $ = cheerio.load(html);
  const jobs: JobviteJob[] = [];
  $("table.jv-job-list tbody tr").each((_, tr) => {
    const row = $(tr);
    const link = row.find("td.jv-job-list-name a").first();
    const href = link.attr("href");
    if (href === undefined) return;
    const id = matchGroup(/\/job\/([A-Za-z0-9]+)/, href);
    if (id === null) return;
    jobs.push({
      id,
      title: collapseWs(link.text()),
      location: collapseWs(row.find("td.jv-job-list-location").first().text()),
    });
  });
  const pagText = collapseWs($(".jv-pagination-text").first().text());
  const totalStr = matchGroup(/of\s+([\d,]+)/, pagText);
  const total = totalStr === null ? null : Number(totalStr.replace(/,/g, ""));
  return { jobs, total };
}

/** Parse a job page: JD text plus the meta locations (department stripped). */
export function parseJobviteJd(html: string): { jdText: string; location: string | null } {
  const $ = cheerio.load(html);
  const jdText = htmlToText($(".jv-job-detail-description").first().html() ?? "");
  // jv-inline-separator spans delimit segments; walk nodes structurally, a text sentinel can't survive the HTML parser
  const segments: string[] = [];
  let buf = "";
  $(".jv-job-detail-meta").first().contents().each((_, node) => {
    if (node.type === "tag" && $(node).hasClass("jv-inline-separator")) {
      segments.push(buf);
      buf = "";
    } else {
      buf += $(node).text();
    }
  });
  segments.push(buf);
  const cleaned = segments.map(collapseWs).filter((s) => s !== "");
  const location = cleaned.length > 1 ? cleaned.slice(1).join("; ") : null;
  return { jdText, location };
}

function toPosting(j: JobviteJob, tenant: string, company: AdapterCompany): NormalizedPosting {
  return {
    provider: "jobvite",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${ORIGIN}/${tenant}/job/${j.id}`,
    location: j.location === "" ? null : j.location,
    isRemote: REMOTE_RE.test(j.location) || REMOTE_RE.test(j.title),
    jdText: "",
    postedAt: null,
  };
}

export const jobviteAdapter: AtsAdapter = {
  provider: "jobvite",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const tenant = jobviteTenant(company);
    const jobs = await paginate<JobviteJob>({
      provider: "jobvite",
      company: company.slug,
      pageSize: "infer",
      fetchPage: async (_offset, page) => {
        const { html, finalUrl } = await atsFetchHtml(jobviteSearchUrl(tenant, page), { provider: "jobvite" });
        if (!finalUrl.startsWith(`${ORIGIN}/`)) {
          throw new Error(
            `jobvite: tenant ${tenant} does not exist — the board redirected off-host to ${finalUrl}`,
          );
        }
        const { jobs: items, total } = parseJobviteList(html);
        return { items, total, noPaginationControl: total === null };
      },
      dedupeBy: (j) => j.id,
    });
    return jobs.map((j) => toPosting(j, tenant, company));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(posting.jobUrl, { provider: "jobvite" });
    const { jdText, location } = parseJobviteJd(html);
    if (jdText === "") {
      logger.warn({ company: company.slug, job: posting.externalId }, "jobvite: job page had no description block");
    }
    if (location !== null && (posting.location === null || LOCATION_PLACEHOLDER_RE.test(posting.location))) {
      posting.location = location;
    }
    return jdText;
  },
};
