// SAP SuccessFactors sitemap.xml completeness backstop, shared by sfcsb.ts and successfactors.ts: <tenant origin>/sitemap.xml serves the tenant's COMPLETE job-URL set in one request as a plain <urlset> (e.g. <url><loc>https://careers.payu.in/PayU/job/.../53951080/</loc>...</url>).
// Some tenants serve an <rss> feed at the same path instead - detected, not ingested. Never throws: any failure degrades to null so a sitemap outage can never fail a board that was otherwise fine.
import { logger } from "../logger.js";
import type { AdapterCompany } from "../types.js";
import { atsFetchText } from "./http.js";
import { tenantOrigin } from "./shared.js";
import { describeError } from "../util/errorCause.js";

/** Runaway guard on one board's sitemap gap-fill, not a limit: far above any real tenant's whole job count. */
export const SITEMAP_GAP_FILL_GUARD = 50_000;

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const JOB_ID_RE = /\/job\/.*\/(\d+)\/?$/;
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ent: string) => {
    const lower = ent.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return XML_ENTITIES[lower] ?? whole;
  });
}

/** Parse a sitemap.xml body into id -> job URL, keeping only /job/.../<digits>/ locs. Pure, never throws. */
export function parseSfSitemapUrlset(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(LOC_RE)) {
    const loc = decodeXmlEntities((m[1] ?? "").trim());
    const idMatch = JOB_ID_RE.exec(loc);
    const id = idMatch?.[1];
    if (id === undefined) continue;
    out.set(id, loc);
  }
  return out;
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
  const words = safeDecodeUri(slugSeg ?? "").split(/[-_]+/).filter((w) => w !== "");
  if (words.length === 0) return "Untitled role";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Sitemap entries whose id the listing never returned, in sitemap order; stops (with a warning) only at the runaway guard. */
export function sitemapOnlyEntries(
  sitemap: ReadonlyMap<string, string>,
  listed: ReadonlySet<string>,
  ctx: { slug: string; provider: string },
  guard: number = SITEMAP_GAP_FILL_GUARD,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [id, url] of sitemap) {
    if (listed.has(id)) continue;
    if (out.length >= guard) {
      logger.warn({ slug: ctx.slug, guard }, `${ctx.provider}: sitemap gap-fill hit the runaway guard - board may be truncated`);
      break;
    }
    out.push([id, url]);
  }
  return out;
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
