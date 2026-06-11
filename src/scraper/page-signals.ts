import * as cheerio from "cheerio";
import { extractJsonLdJobs } from "./json-ld.js";
import { ROLE_TEXT_RE } from "./cheerio.js";

const CAREERS_WORD_RE = /\b(careers?|jobs?|openings?|positions?|vacanc|hiring|join\s+(us|our\s+team)|work\s+with\s+us|opportunit)/i;

export interface CareersPageSignals {
  /** Title/headings/path mention careers words, role words appear, or JobPosting JSON-LD exists. */
  looksLikeCareersPage: boolean;
  /** Requested a real path but landed on the site root — classic moved-page tell. */
  redirectedToRoot: boolean;
}

/**
 * Conservative "is this even a careers page?" check, used only when a scrape
 * produced zero postings. False positives (treating a wrong page as a careers
 * page) are cheap — the company just stays in rotation. False negatives are
 * what we guard against: a real-but-empty careers page must NOT be flagged
 * suspect, so several independent signals each suffice to pass.
 */
export function analyzeCareersPage(html: string, finalUrl: string, requestedUrl: string): CareersPageSignals {
  let redirectedToRoot = false;
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);
    redirectedToRoot =
      requested.pathname.replace(/\/+$/, "") !== "" && final.pathname.replace(/\/+$/, "") === "";
  } catch {
    // unparseable — leave defaults
  }

  const $ = cheerio.load(html);
  const title = $("title").text();
  const headings = $("h1, h2").map((_, el) => $(el).text()).get().join(" ");
  const bodySample = $("body").text().replace(/\s+/g, " ").slice(0, 4000);

  // Content signals only — the URL path is what WE requested, so a homepage
  // served at /careers would pass a path check and defeat the whole purpose.
  const looksLikeCareersPage =
    CAREERS_WORD_RE.test(title) ||
    CAREERS_WORD_RE.test(headings) ||
    ROLE_TEXT_RE.test(bodySample) ||
    extractJsonLdJobs(html).length > 0;

  return { looksLikeCareersPage, redirectedToRoot };
}
