// src/ats/recrew.ts — Recrew AI agency board (talent.recrew.ai/careers): server-rendered listing of .job-card items (data-job-uuid/title/location attrs).
// JD is served by GET /job/job-board/<uuid>/detail/modal, which 400s without X-Requested-With; public per-job pages use an underivable slug, so jobUrl points at the board with the uuid as a query marker.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml, atsFetchText } from "./http.js";
import { REMOTE_RE, collapseWs } from "./shared.js";

const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

export function recrewOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

export function recrewListUrl(company: AdapterCompany): string {
  return `${recrewOrigin(company)}/careers/`;
}

export function recrewModalUrl(company: AdapterCompany, uuid: string): string {
  return `${recrewOrigin(company)}/job/job-board/${encodeURIComponent(uuid)}/detail/modal`;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Parses the listing; the page renders every card twice (mobile + desktop), so items dedupe on uuid. */
export function parseRecrewList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: NormalizedPosting[] = [];
  $(".job-card[data-job-uuid]").each((_, el) => {
    const $el = $(el);
    const uuid = ($el.attr("data-job-uuid") ?? "").trim();
    if (!uuid || seen.has(uuid)) return;
    const title = collapseWs($el.find(".job-title").first().text()) || titleCase(($el.attr("data-title") ?? "").trim());
    if (!title || /leave your resume/i.test(title)) return;
    seen.add(uuid);
    const rawLoc = collapseWs($el.attr("data-location") ?? "");
    const location = rawLoc ? titleCase(rawLoc) : null;
    const workplace = ($el.attr("data-workplace") ?? "").toLowerCase();
    out.push({
      provider: "recrew",
      externalId: uuid,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: `${recrewListUrl(company)}?job=${encodeURIComponent(uuid)}`,
      location,
      isRemote: workplace === "remote" || (location ? REMOTE_RE.test(location) : false),
      jdText: "",
      postedAt: null,
    });
  });
  return out;
}

export function parseRecrewJd(modalHtml: string): string {
  const $ = cheerio.load(modalHtml);
  $("button, form, script, style, svg").remove();
  return htmlToText($.root().html() ?? "");
}

export const recrewAdapter: AtsAdapter = {
  provider: "recrew",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(recrewListUrl(company), { provider: "recrew" });
    return parseRecrewList(html, company);
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { html } = await atsFetchHtml(recrewModalUrl(company, posting.externalId), { provider: "recrew", headers: XHR_HEADERS });
    return parseRecrewJd(html);
  },
};
