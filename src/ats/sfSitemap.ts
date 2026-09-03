// SAP SuccessFactors sitemap.xml completeness backstop, shared by sfcsb.ts and successfactors.ts: <tenant origin>/sitemap.xml serves the tenant's COMPLETE job-URL set in one request as a plain <urlset> (e.g. <url><loc>https://careers.payu.in/PayU/job/.../53951080/</loc>...</url>).
// Some tenants serve an <rss> feed at the same path instead - detected, not ingested. Never throws: any failure degrades to null so a sitemap outage can never fail a board that was otherwise fine.
import { logger } from "../logger.js";
import type { AdapterCompany } from "../types.js";
import { atsFetchText } from "./http.js";
import { tenantOrigin } from "./shared.js";
import { describeError } from "../util/errorCause.js";

/** Shared runaway guard for sitemap gap-fills, one run's worth of extra jobs per company. */
export const SITEMAP_GAP_FILL_CAP = 500;

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const JOB_ID_RE = /\/job\/.*\/(\d+)\/?$/;

/** Parse a sitemap.xml body into id -> job URL, keeping only /job/.../<digits>/ locs. Pure, never throws. */
export function parseSfSitemapUrlset(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(LOC_RE)) {
    const loc = (m[1] ?? "").trim();
    const idMatch = JOB_ID_RE.exec(loc);
    const id = idMatch?.[1];
    if (id === undefined) continue;
    out.set(id, loc);
  }
  return out;
}

/** Provisional job title for a sitemap-only gap-fill: de-kebab the URL's slug segment (the one right before
 *  the trailing id) and title-case it. Only used until the board's own listing picks the job up for real. */
export function titleFromSitemapUrl(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an absolute URL — fall back to slicing the raw string below.
  }
  const segments = path.split("/").filter((s) => s !== "");
  const slugSeg = segments.length >= 2 ? segments[segments.length - 2] : segments[segments.length - 1];
  const words = (slugSeg ?? "").split(/[-_]+/).filter((w) => w !== "");
  if (words.length === 0) return "Untitled role";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Fetch <tenant origin>/sitemap.xml as a completeness backstop: id -> url map (empty is valid), or null on ANY failure incl. the <rss> feed variant (logged, not ingested). */
export async function fetchSfSitemapIds(company: AdapterCompany, provider: string): Promise<Map<string, string> | null> {
  let origin: string;
  try {
    origin = tenantOrigin(company);
  } catch (err) {
    logger.warn({ slug: company.slug, err: describeError(err) }, `${provider} sitemap: could not derive tenant origin`);
    return null;
  }
  const url = `${origin}/sitemap.xml`;
  try {
    const body = await atsFetchText(url, { provider });
    if (/<rss[\s>]/i.test(body)) {
      logger.info({ slug: company.slug }, `${provider} rss sitemap variant available`);
      return null;
    }
    if (!/<urlset[\s>]/i.test(body)) {
      logger.warn({ slug: company.slug }, `${provider} sitemap: response has no <urlset>`);
      return null;
    }
    return parseSfSitemapUrlset(body);
  } catch (err) {
    logger.warn({ slug: company.slug, err: describeError(err) }, `${provider} sitemap fetch failed`);
    return null;
  }
}
