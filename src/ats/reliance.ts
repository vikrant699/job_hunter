// src/ats/reliance.ts — Reliance Industries corporate careers board
// (careers.ril.com/rilcareers), a classic ASP.NET WebForms site. Single
// tenant: RIL corporate only. Jio (careers.jio.com) and Retail
// (rcareers.ril.com, SAP E-Recruiting) run entirely different stacks and are
// OUT of scope for this adapter.
//
// Board:  https://careers.ril.com/rilcareers/frmjobsearch.Aspx
// Detail: https://careers.ril.com/rilcareers/frmJobSearch.aspx?JBTITLE=...&jbID=...
//         (relative link taken straight from the list page; JBTITLE/jbID are
//         opaque encrypted params — not usable as a stable id, so externalId
//         instead uses the numeric requisition code embedded in the title,
//         e.g. "CS Operations Lead 2 - CS ( 82861680 )" -> "82861680").
//
// Pagination: ~10 jobs/page, ~6 pages, paged via __doPostBack on the pager's
// page-number <select> (ctl00$MainContent$rgJobs$ctl13$PageDropDownList).
// __VIEWSTATE is self-contained here — confirmed live that paging works with
// NO session cookie carried between requests — so each page's hidden
// __VIEWSTATE/__EVENTVALIDATION/etc. fields just need to be re-extracted from
// that page's HTML and POSTed back with the target page number appended. No
// WAF in front of this board; the plain bot UA (config.fetch.userAgent) is
// enough, no browser UA needed.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText, atsFetchFormHtml } from "./http.js";
import { REMOTE_RE, warnDeepPagination } from "./shared.js";
import { kebabCase } from "../util/slug.js";

export const RELIANCE_BOARD_URL = "https://careers.ril.com/rilcareers/frmjobsearch.Aspx";

/** Both the __EVENTTARGET value and the form field name for the pager's page-number <select>. */
const PAGE_FIELD = "ctl00$MainContent$rgJobs$ctl13$PageDropDownList";

const PAGE_LABEL_RE = /Showing\s+(\d+)\s+of\s+(\d+)\s+Pages?/i;
const JOB_CODE_RE = /[[(]\s*(\d+)\s*[\])]\s*$/;

export interface RelianceJobRow {
  title: string;
  href: string;
  functionalArea: string;
  location: string;
  postedOn: string;
}

export interface RelianceListPage {
  rows: RelianceJobRow[];
  currentPage: number;
  totalPages: number;
}

/**
 * Pull every non-button form control's current value out of the WebForms
 * <form> — the hidden __VIEWSTATE/__EVENTVALIDATION/etc. state, the (empty)
 * search filters, and the ddlentries/pager <select>s. Submit/image inputs are
 * excluded: the postback here is always driven by a <select>'s onchange
 * (__doPostBack), never by "clicking" a button, so a real browser wouldn't
 * include any button's value in this particular request either.
 */
export function extractFormFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const form = $("form").first();
  const fields: Record<string, string> = {};

  form.find("input").each((_i, el) => {
    const $el = $(el);
    const type = ($el.attr("type") ?? "text").toLowerCase();
    const name = $el.attr("name");
    if (!name || type === "submit" || type === "image" || type === "button") return;
    fields[name] = $el.attr("value") ?? "";
  });

  form.find("select").each((_i, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const selected = $el.find("option[selected]").attr("value") ?? $el.find("option").first().attr("value") ?? "";
    fields[name] = selected;
  });

  return fields;
}

/**
 * Parse one rendered list page: job rows plus the "Showing X of Y Pages"
 * pager state. Boards small enough to fit on one page (<=10 jobs) may omit
 * the pager row entirely — treated as page 1 of 1.
 */
export function parseRelianceListPage(html: string): RelianceListPage {
  const $ = cheerio.load(html);
  const rows: RelianceJobRow[] = [];

  $("#MainContent_rgJobs tbody > tr").each((_i, el) => {
    const tds = $(el).children("td");
    if (tds.length < 5) return; // the pager row is a single colspan cell
    const a = $(tds[1]).find("a").first();
    const href = a.attr("href");
    const title = a.text().trim();
    if (!href || !title) return;
    rows.push({
      title,
      href,
      functionalArea: $(tds[2]).text().trim(),
      location: $(tds[3]).text().trim(),
      postedOn: $(tds[4]).text().trim(),
    });
  });

  const pagerText = $("#MainContent_rgJobs_CurrentPageLabel").text();
  const m = PAGE_LABEL_RE.exec(pagerText);
  return {
    rows,
    currentPage: m ? Number(m[1]) : 1,
    totalPages: m ? Number(m[2]) : 1,
  };
}

/**
 * Requisition code embedded at the end of the title, e.g.
 * "CS Operations Lead 2 - CS ( 82861680 )" -> "82861680". Falls back to a
 * kebab-cased slug of the title when it has no parseable code — NOT the
 * detail href: its JBTITLE/jbID params are encrypted and possibly
 * session-varying (see the module doc above), so they are not a safe stable
 * id. A title-slug fallback can still collide/rotate across runs if the
 * title itself changes, but cross-run notifyKey dedup (company|title|
 * location) suppresses re-notification for the one-time id-scheme change
 * this introduces for rows already seen under the old href-based id.
 */
export function relianceExternalId(row: Pick<RelianceJobRow, "title" | "href">): string {
  return JOB_CODE_RE.exec(row.title)?.[1] ?? kebabCase(row.title);
}

/** "10 Jul 2026" -> ISO, or null if unparseable. */
export function parseRelianceDate(s: string): string | null {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function normalizeReliance(company: AdapterCompany, row: RelianceJobRow): NormalizedPosting {
  const haystack = `${row.functionalArea} ${row.location}`;
  return {
    provider: "reliance",
    externalId: relianceExternalId(row),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: row.title,
    jobUrl: new URL(row.href, RELIANCE_BOARD_URL).toString(),
    location: row.location || null,
    isRemote: REMOTE_RE.test(haystack),
    jdText: "",
    postedAt: parseRelianceDate(row.postedOn),
  };
}

/**
 * Build the POST body for advancing to `targetPage` via the pager
 * <select>'s onchange postback, starting from a previously extracted page's
 * form fields (fresh __VIEWSTATE required each hop).
 */
export function buildPageRequestBody(fields: Record<string, string>, targetPage: number): Record<string, string> {
  return {
    ...fields,
    __EVENTTARGET: PAGE_FIELD,
    __EVENTARGUMENT: "",
    [PAGE_FIELD]: String(targetPage),
  };
}

/**
 * Job description block on the detail page — one div holding responsibilities,
 * education/experience requirements, and skills/competencies together.
 *
 * The live markup embeds Facebook/LinkedIn share buttons whose `href`
 * attributes contain a literal, unescaped "<url>" placeholder (invalid HTML —
 * confirmed on the live site). That trips up htmlText.ts's regex-based tag
 * stripper (it's documented as only safe for well-formed HTML), so this
 * removes those buttons — plus the Apply/Back submit inputs, neither of
 * which belongs in the JD body — with cheerio (a real, tolerant HTML parser)
 * *before* falling back to htmlToText for whitespace normalization.
 */
export function parseRelianceJd(html: string): string {
  const $ = cheerio.load(html);
  const div = $("#MainContent_divDesc");
  if (div.length === 0) return "";
  div.find("script, style, input, .in-class").remove();
  return htmlToText(div.text());
}

export const relianceAdapter: AtsAdapter = {
  provider: "reliance",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const rows: RelianceJobRow[] = [];

    const html = await atsFetchText(RELIANCE_BOARD_URL, { provider: "reliance" });
    let page = parseRelianceListPage(html);
    rows.push(...page.rows);
    let fields = extractFormFields(html);

    // No fixed page cap (a genuinely large board should be paged in full) —
    // but if the server ever stops advancing `currentPage` (a stuck postback,
    // e.g. from a viewstate/field mismatch) this must not spin forever.
    let pagesFetched = 1;
    while (page.currentPage < page.totalPages) {
      const target = page.currentPage + 1;
      const body = buildPageRequestBody(fields, target);
      const nextHtml = await atsFetchFormHtml(RELIANCE_BOARD_URL, body, { provider: "reliance" });
      const nextPage = parseRelianceListPage(nextHtml);
      if (nextPage.currentPage <= page.currentPage) {
        throw new Error(
          `reliance: pagination stuck at page ${page.currentPage} (requested ${target}, server returned ${nextPage.currentPage}) for ${company.slug}`,
        );
      }
      page = nextPage;
      rows.push(...page.rows);
      fields = extractFormFields(nextHtml);
      pagesFetched += 1;
      warnDeepPagination("reliance", company.slug, pagesFetched, rows.length);
    }

    return rows.map((row) => normalizeReliance(company, row));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "reliance" });
    return parseRelianceJd(html);
  },
};
