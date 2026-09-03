// src/ats/jsonld.ts — generic adapter for schema.org JobPosting JSON-LD in static HTML; listing discovers job-page URLs via sitemaps (robots.txt Sitemap: lines, /sitemap.xml, /sitemap_index.xml, INDEX sub-sitemaps), falling back to harvesting careers-landing-page links when that comes up short
// title/location/JD are resolved from each job page's own JSON-LD at fetchJd time - listPostings only emits a provisional URL-derived title; no detect.ts pattern (custom-domain sites, not a shared vendor host)
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchText } from "./http.js";
import { tenantOrigin, dateToIso, joinLocation, collapseWs } from "./shared.js";
import { htmlToText } from "./htmlText.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { describeError } from "../util/errorCause.js";
import { logger } from "../logger.js";

// Runaway backstop so one enormous board never floods a single run.
const MAX_JOB_URLS = 3000;
// per-board cap on sub-sitemap fetches when following a sitemap INDEX (root candidates - robots.txt entries, /sitemap.xml, /sitemap_index.xml - aren't counted against this)
const MAX_SUBSITEMAPS = 25;
// Careers landing pages tried, in order, when the sitemap pass finds fewer than 3 job URLs.
const FALLBACK_PATHS = ["/careers", "/jobs", "/", "/careers/jobs", "/join-us"];

const ASSET_EXT_RE = /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|xml|json|zip|mp4)(?:[?#]|$)/i;
const NAV_PATH_RE = /\/(feed|rss|sitemap|category|categories|search|tag|tags|page|about|contact|privacy|login|faq)(?:\/|$|\?)/i;
const ROLE_SEGMENT_RE = /^(jobs?|careers?|vacan\w*|positions?|openings?)$/i;
const JOB_ID_QUERY_RE = /[?&](jobid|job_id|gh_jid|reqid|requisitionid|opportunityid)=/i;
const JOB_SITEMAP_RE = /job|career|vacan|position|opening/i;
const XML_EXT_RE = /\.xml(?:[?#]|$)/i;

/** A job-shaped path (jobs/careers/vacancy/position/opening segment + a further slug) or a jobid-ish query param — minus asset extensions and listing/nav paths. */
export function isJobDetailUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (ASSET_EXT_RE.test(u.pathname)) return false;
  if (NAV_PATH_RE.test(u.pathname)) return false;
  const segs = u.pathname.split("/").filter((s) => s !== "");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg !== undefined && ROLE_SEGMENT_RE.test(seg) && segs[i + 1]) return true;
  }
  if (JOB_ID_QUERY_RE.test(u.search)) return true;
  return false;
}

/** De-slug the URL's last path segment into a provisional title (refined by fetchJd's JSON-LD read). */
export function titleFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const segments = path.split("/").filter((s) => s !== "");
  let seg = segments[segments.length - 1] ?? "";
  try {
    seg = decodeURIComponent(seg);
  } catch {
    // Malformed %-escape — use the raw segment.
  }
  seg = seg.replace(/\.(html|aspx|php)$/i, "");
  seg = seg.replace(/[-_]+/g, " ");
  seg = seg.replace(/\b\d{4,}\b/g, " ");
  seg = collapseWs(seg);
  if (!seg) return "(position)";
  let title = seg
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  if (title.length > 140) title = title.slice(0, 140).trim();
  return title || "(position)";
}

/** externalId is the URL stripped of scheme, query and fragment. */
function externalIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

function normalizeJsonldPosting(company: AdapterCompany, url: string): NormalizedPosting {
  return {
    provider: "jsonld",
    externalId: externalIdFromUrl(url),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: titleFromUrl(url),
    jobUrl: url,
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
  };
}

/** atsFetchText wrapped so one dead discovery URL (robots.txt, a stale sub-sitemap, a landing page) never kills the rest of the discovery pass. */
async function fetchTextSafe(url: string, slug: string): Promise<string | null> {
  try {
    return await atsFetchText(url, { provider: "jsonld" });
  } catch (err) {
    logger.warn({ slug, url, err: describeError(err) }, "jsonld: discovery fetch failed");
    return null;
  }
}

function parseRobotsSitemaps(text: string): string[] {
  const out: string[] = [];
  const re = /^sitemap:\s*(\S+)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const u = m[1];
    if (u) out.push(u.trim());
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}
function isUrlset(xml: string): boolean {
  return /<urlset[\s>]/i.test(xml);
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (raw) out.push(raw.replace(/&amp;/g, "&").trim());
  }
  return out;
}

/** Discovers job-detail URLs from robots.txt Sitemap: lines plus the two conventional paths, following any sitemap INDEX's sub-sitemaps (job-shaped ones first) up to MAX_SUBSITEMAPS; never throws, a failed step just leaves its URLs uncollected. */
async function collectSitemapJobUrls(host: string, slug: string): Promise<Set<string>> {
  const jobUrls = new Set<string>();

  const robotsBody = await fetchTextSafe(`${host}/robots.txt`, slug);
  const robotsSitemaps = robotsBody ? parseRobotsSitemaps(robotsBody) : [];

  const rootCandidates: string[] = [];
  const seenRoot = new Set<string>();
  for (const u of [...robotsSitemaps, `${host}/sitemap.xml`, `${host}/sitemap_index.xml`]) {
    if (!seenRoot.has(u)) {
      seenRoot.add(u);
      rootCandidates.push(u);
    }
  }

  const subQueue: string[] = [];
  const queuedSub = new Set<string>();
  const enqueueSubSitemaps = (locs: string[]): void => {
    const matching = locs.filter((u) => JOB_SITEMAP_RE.test(u));
    const other = locs.filter((u) => !JOB_SITEMAP_RE.test(u) && XML_EXT_RE.test(u));
    for (const u of [...matching, ...other]) {
      if (!queuedSub.has(u)) {
        queuedSub.add(u);
        subQueue.push(u);
      }
    }
  };

  for (const url of rootCandidates) {
    const body = await fetchTextSafe(url, slug);
    if (!body) continue;
    if (isSitemapIndex(body)) {
      enqueueSubSitemaps(extractLocs(body));
    } else if (isUrlset(body)) {
      for (const loc of extractLocs(body)) {
        if (isJobDetailUrl(loc)) jobUrls.add(loc);
      }
    }
  }

  let subFetches = 0;
  for (const subUrl of subQueue) {
    if (subFetches >= MAX_SUBSITEMAPS) break;
    subFetches++;
    const body = await fetchTextSafe(subUrl, slug);
    if (!body) continue;
    if (isUrlset(body)) {
      for (const loc of extractLocs(body)) {
        if (isJobDetailUrl(loc)) jobUrls.add(loc);
      }
    } else if (isSitemapIndex(body)) {
      enqueueSubSitemaps(extractLocs(body));
    }
  }

  return jobUrls;
}

/** Fallback when the sitemap pass finds fewer than 3 job URLs: harvest job-shaped <a href> values off conventional careers landing pages, stopping early once 3 are found. */
async function harvestFromLandingPages(host: string, slug: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const path of FALLBACK_PATHS) {
    if (found.size >= 3) break;
    const pageUrl = `${host}${path}`;
    const html = await fetchTextSafe(pageUrl, slug);
    if (!html) continue;
    const $ = cheerio.load(html);
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      let abs: URL;
      try {
        abs = new URL(href, pageUrl);
      } catch {
        return;
      }
      abs.hash = "";
      const absStr = abs.toString();
      if (isJobDetailUrl(absStr)) found.add(absStr);
    });
  }
  return found;
}

const NamedEntrySchema = z.union([
  z.string(),
  z.object({ name: z.union([z.string(), z.null()]).optional() }).passthrough(),
]).nullable();

const AddressCountrySchema = z.union([
  z.string(),
  z.object({ name: z.union([z.string(), z.null()]).optional() }).passthrough(),
]).nullable().optional();

const PostalAddressSchema = z.object({
  addressLocality: z.union([z.string(), z.null()]).optional(),
  addressRegion: z.union([z.string(), z.null()]).optional(),
  addressCountry: AddressCountrySchema,
}).passthrough();

const PlaceAddressSchema = z.union([z.string(), PostalAddressSchema]).nullable().optional();

const JobLocationEntrySchema = z.union([
  z.string(),
  z.object({ address: PlaceAddressSchema }).passthrough(),
]).nullable();

const JobLocationSchema = z.union([JobLocationEntrySchema, z.array(JobLocationEntrySchema)]).nullable().optional();
const ApplicantLocationRequirementsSchema = z.union([NamedEntrySchema, z.array(NamedEntrySchema)]).nullable().optional();

const JobPostingNodeSchema = z.object({
  title: z.union([z.string(), z.null()]).optional(),
  description: z.union([z.string(), z.null()]).optional(),
  datePosted: z.union([z.string(), z.null()]).optional(),
  jobLocation: JobLocationSchema,
  applicantLocationRequirements: ApplicantLocationRequirementsSchema,
  jobLocationType: z.union([z.string(), z.null()]).optional(),
}).passthrough();

type JobPostingNode = z.infer<typeof JobPostingNodeSchema>;
type JobLocationEntry = z.infer<typeof JobLocationEntrySchema>;
type NamedEntry = z.infer<typeof NamedEntrySchema>;

function typeIncludesJobPosting(t: JsonValue): boolean {
  if (typeof t === "string") return t === "JobPosting";
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x === "JobPosting");
  return false;
}

/** Depth-first walk of a parsed JSON-LD payload (arrays and @graph arrays only) for the first node whose @type is/includes "JobPosting". */
function findJobPostingRaw(value: JsonValue): Record<string, JsonValue> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPostingRaw(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    const typeVal = value["@type"];
    if (typeVal !== undefined && typeIncludesJobPosting(typeVal)) return value;
    const graph = value["@graph"];
    if (graph !== undefined && Array.isArray(graph)) {
      const found = findJobPostingRaw(graph);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/** First JobPosting node across every <script type="application/ld+json"> block on the page, or null. */
function findJobPostingNode(html: string): JobPostingNode | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    const text = $(el).html() ?? "";
    const parsed = tryParseJson(text);
    if (parsed === null) continue;
    const raw = findJobPostingRaw(parsed);
    if (raw === null) continue;
    const result = JobPostingNodeSchema.safeParse(raw);
    if (result.success) return result.data;
  }
  return null;
}

function addressText(addr: z.infer<typeof PlaceAddressSchema>): string | null {
  if (addr == null) return null;
  if (typeof addr === "string") return addr.trim() || null;
  const country =
    addr.addressCountry == null
      ? null
      : typeof addr.addressCountry === "string"
        ? addr.addressCountry
        : addr.addressCountry.name ?? null;
  return joinLocation(addr.addressLocality ?? null, addr.addressRegion ?? null, country);
}

function placeText(entry: JobLocationEntry): string | null {
  if (entry == null) return null;
  if (typeof entry === "string") return entry.trim() || null;
  return addressText(entry.address ?? null);
}

function locationTextsFromJobLocation(jobLocation: JobPostingNode["jobLocation"]): string[] {
  if (jobLocation == null) return [];
  const arr = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  const out: string[] = [];
  for (const entry of arr) {
    const t = placeText(entry);
    if (t) out.push(t);
  }
  return out;
}

function nameText(entry: NamedEntry): string | null {
  if (entry == null) return null;
  if (typeof entry === "string") return entry.trim() || null;
  return entry.name?.trim() || null;
}

function namesFromApplicantReq(v: JobPostingNode["applicantLocationRequirements"]): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const entry of arr) {
    const t = nameText(entry);
    if (t) out.push(t);
  }
  return out;
}

function isTelecommute(node: JobPostingNode): boolean {
  return (node.jobLocationType ?? "").toUpperCase() === "TELECOMMUTE";
}

/** posting.location: jobLocation address parts (joined "; ", capped at 4) — else applicantLocationRequirements names or a bare "Remote" when jobLocationType is TELECOMMUTE. */
function locationFromNode(node: JobPostingNode): string | null {
  const locs = locationTextsFromJobLocation(node.jobLocation);
  if (locs.length > 0) return locs.slice(0, 4).join("; ");
  const names = namesFromApplicantReq(node.applicantLocationRequirements);
  if (isTelecommute(node)) {
    return names.length > 0 ? `Remote - ${names.slice(0, 4).join("; ")}` : "Remote";
  }
  if (names.length > 0) return names.slice(0, 4).join("; ");
  return null;
}

export const jsonldAdapter: AtsAdapter = {
  provider: "jsonld",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const host = tenantOrigin(company);
    let urls = await collectSitemapJobUrls(host, company.slug);
    if (urls.size < 3) {
      const fallback = await harvestFromLandingPages(host, company.slug);
      urls = new Set([...urls, ...fallback]);
    }
    if (urls.size === 0) return [];
    return [...urls].slice(0, MAX_JOB_URLS).map((url) => normalizeJsonldPosting(company, url));
  },

  // refines posting.jobTitle / posting.location / posting.isRemote / posting.postedAt in place from the job page's own JSON-LD
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "jsonld" });
    const node = findJobPostingNode(html);
    if (!node) return "";
    const description = node.description ?? null;
    if (!description) return "";
    const jdText = htmlToText(description);

    const title = (node.title ?? "").trim();
    if (title) posting.jobTitle = title.length > 200 ? title.slice(0, 200) : title;

    const location = locationFromNode(node);
    if (location) posting.location = location;
    if (isTelecommute(node)) posting.isRemote = true;

    const postedAt = dateToIso(node.datePosted ?? null);
    if (postedAt) posting.postedAt = postedAt;

    return jdText;
  },
};
