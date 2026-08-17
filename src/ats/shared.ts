import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import type { AdapterCompany } from "../types.js";

export const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|virtual)\b/i;

/** Politeness delay between pagination requests, shared by all API adapters. */
export const INTER_PAGE_DELAY_MS = 150;

export { sleep };

// 100+ pages usually means a termination bug or a genuinely huge board - either way worth a log line. Warn, don't stop.
const PAGE_WARN_INTERVAL = 100;

export function warnDeepPagination(provider: string, slug: string, pagesDone: number, jobsSoFar: number): void {
  if (pagesDone % PAGE_WARN_INTERVAL === 0) {
    logger.warn({ slug, pages: pagesDone, jobsSoFar }, `${provider} pagination still going — unusually large tenant`);
  }
}

// Backstop against a tenant whose `total` is unreliable and never returns a short/empty page; set high so completeness wins and no real board is ever truncated (warnDeepPagination logs loudly well before this, and once more if the cap itself ends the loop).
export const DEFAULT_MAX_PAGES = 5000;

/** How to report an exact-repeat pagination stall: which level, and a message that claims only what the numbers support. */
export interface PaginationStallReport {
  level: "warn" | "info";
  message: string;
}

/** Warn only when the collected total fell short of a reported total (proof rows were lost); otherwise info - a board re-serving its last page instead of an empty one is usually complete, and warning on that too would train us to ignore the line that matters. */
export function describePaginationStall(state: {
  total: number | null;
  collected: number;
  /** True only when the response itself proved the board has no pagination control (e.g. gohire renders no pager below one page); absent/false means "unknown", not "has one". */
  noPaginationControl?: boolean;
}): PaginationStallReport {
  const { total, collected } = state;
  if (total !== null && collected < total) {
    return {
      level: "warn",
      message: `pagination stalled short of the reported total - collected ${collected} of ${total} (board re-served the previous page instead of advancing)`,
    };
  }
  // Checked before the null-total hedge below (stronger evidence: no pager means no second page) but after the shortfall warn, so a contradiction between the two signals still resolves loudly.
  if (state.noPaginationControl === true) {
    return {
      level: "info",
      message: `pagination ended: board has no pagination control, so a single page is the whole board - collected ${collected}`,
    };
  }
  if (total === null) {
    return {
      level: "info",
      // No total means no way to check - say completeness is unverifiable rather than implying "all good".
      message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected}, and with no total exposed completeness is unverifiable`,
    };
  }
  return {
    level: "info",
    message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected} of ${total} reported`,
  };
}

/** One page's items and, if known, the API's total item count. `rawCount`, if given, is the record count before adapter-side filtering (e.g. Phenom drops postings with no stable id) - offset advance and short-page detection use this instead of `items.length` so filtered-out records don't shift the next offset. Defaults to `items.length`. */
export interface PaginatePage<T> {
  items: T[];
  total: number | null;
  rawCount?: number;
  /** True only when this response proved the board has no pagination control (gohire omits the pager below one page); upgrades the stall log to a positive statement, never affects termination. */
  noPaginationControl?: boolean;
}

export interface PaginateOpts<T> {
  /** Adapter name, used only for the deep-pagination warn log line. */
  provider: string;
  /** Company slug, used only for the deep-pagination warn log line. */
  company: string;
  /** Expected page size - a shorter page ends the loop. Pass "infer" when it's a per-TENANT property rather than an engine constant (e.g. SuccessFactors serves 10 rows to one tenant, 25 to another) - the first page's own count becomes the size. */
  pageSize: number | "infer";
  /** Runaway backstop on page count, for a tenant whose `total` is unreliable and never returns a short/empty page. Default 5000 - high enough never to truncate a real board. */
  maxPages?: number;
  /** Whether a page shorter than `pageSize` (but non-empty) ends pagination. True for tenants whose page size is authoritative (Workday, SmartRecruiters, Eightfold, Oracle); some (e.g. Phenom) may serve fewer items without meaning "last page" - those pass `false` and rely on a zero-item page or reaching `total`. Default true. */
  shortPageEndsPagination?: boolean;
  /** Delay between page fetches, in ms. Defaults to `INTER_PAGE_DELAY_MS`; tests pass 0. */
  interPageDelayMs?: number;
  /** Fetch one page at the given offset (0-based, page-th call). See `PaginatePage` for field semantics. */
  fetchPage: (offset: number, page: number) => Promise<PaginatePage<T>>;
  /** Drops any item whose key was already accumulated on an earlier page (for tenants whose pages can overlap). Purely a filter on what's accumulated - `rawCount`/`items.length` (and so the offset advance and termination checks) are computed from the page as fetched, so duplicates never shift later offsets. */
  dedupeBy?: (item: T) => string;
}

// Shared offset-pagination loop for Workday, SmartRecruiters, Eightfold, Oracle, Phenom and others: fetch a page, accumulate, stop on a zero-item page, (usually) a short page, a first-seen `total` reached, or the hard page cap. Offset advances by items actually received (not a fixed size), so it's also correct when a server returns fewer than requested. Hitting the hard cap (vs. any other stop condition) logs a runaway warning, since the board may have been truncated.
export async function paginate<T>(opts: PaginateOpts<T>): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const shortPageEndsPagination = opts.shortPageEndsPagination ?? true;
  const interPageDelayMs = opts.interPageDelayMs ?? INTER_PAGE_DELAY_MS;
  const dedupeBy = opts.dedupeBy;
  // Null until known: "infer" latches it off the first page below.
  let pageSize: number | null = opts.pageSize === "infer" ? null : opts.pageSize;
  const out: T[] = [];
  const seenKeys = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  let page = 0;
  // Key signature of the previous page, for the ignored-offset check below.
  let prevSignature: string | null = null;

  for (; page < maxPages; page++) {
    const { items, total: pageTotal, rawCount, noPaginationControl } = await opts.fetchPage(offset, page);
    let added = 0;
    if (dedupeBy) {
      for (const item of items) {
        const key = dedupeBy(item);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          out.push(item);
          added++;
        }
      }
    } else {
      out.push(...items);
      added = items.length;
    }
    const count = rawCount ?? items.length;

    // Latched before the stall check below so it can report a total this page is the first to expose; nothing else reads `total` earlier, so the loop behaves identically.
    if (total === null && typeof pageTotal === "number") {
      total = pageTotal;
    }

    // Stop only on an EXACT repeat of the prior page (not just previously-seen rows): ignoring the offset param would serve page 0 forever, but some boards legitimately re-serve earlier rows mid-crawl while more pages remain, so a weaker signal would truncate them.
    // The same exact-repeat also happens benignly when a board clamps at its last page and re-serves it; indistinguishable from the response alone, so only the counts decide how loud describePaginationStall logs.
    const signature = dedupeBy ? items.map(dedupeBy).join("\u0000") : null;
    if (signature !== null && items.length > 0 && added === 0 && signature === prevSignature) {
      // The page we stalled ON is a byte-for-byte repeat of the previous one, so its own evidence about the board's pager is the evidence for the repeat.
      const stall = describePaginationStall({
        total,
        collected: out.length,
        noPaginationControl: noPaginationControl ?? false,
      });
      const where = {
        provider: opts.provider,
        company: opts.company,
        page,
        itemsSeen: items.length,
        kept: out.length,
        total,
        noPaginationControl: noPaginationControl ?? false,
      };
      if (stall.level === "warn") logger.warn(where, stall.message);
      else logger.info(where, stall.message);
      break;
    }
    prevSignature = signature;

    if (count === 0) break;
    // Under "infer" the first page IS the page size, so it can never be judged short against itself - the safe direction, since guessing high truncates page 1 while guessing low costs at most one extra fetch.
    pageSize ??= count;
    if (shortPageEndsPagination && count < pageSize) break;
    offset += count;
    if (total !== null && offset >= total) break;

    warnDeepPagination(opts.provider, opts.company, page + 1, out.length);
    await sleep(interPageDelayMs);
  }

  if (page === maxPages) {
    logger.warn(
      { provider: opts.provider, company: opts.company, maxPages },
      "pagination hit the runaway cap - board may be truncated"
    );
  }

  return out;
}

/** Join location fragments, skipping blank/null parts: joinLocation("Pune", null, "India") -> "Pune, India"; all-blank -> null. */
export function joinLocation(...parts: Array<string | null | undefined>): string | null {
  const joined = parts.map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
  return joined || null;
}

/** Collapse all whitespace runs to single spaces and trim. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Slice out a bracket-balanced literal starting at the first `open` bracket after `startMarker`; tracks string state so brackets inside quoted values don't miscount. Null if unbalanced. */
export function extractBalanced(text: string, startMarker: string, open: "[" | "{"): string | null {
  const markerAt = text.indexOf(startMarker);
  if (markerAt < 0) return null;
  const start = text.indexOf(open, markerAt + startMarker.length);
  if (start < 0) return null;
  const close = open === "[" ? "]" : "}";

  let depth = 0;
  let quote: string | null = null; // ' " or `
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? ""; // i < text.length, so always a real char in practice
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Date.parse-able string -> ISO, else null. The ~15 private per-adapter copies collapse into this. */
export function dateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Positive epoch-milliseconds -> ISO, else null (sibling of unixToIso's seconds). */
export function epochMsToIso(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

/** Origin of the tenant's board: tenant_url wins, else careers_url. Throws on an unparseable URL (config error worth failing the company). */
export function tenantOrigin(c: Pick<AdapterCompany, "tenantUrl" | "careersUrl">): string {
  return new URL(c.tenantUrl ?? c.careersUrl).origin;
}

/** Like tenantOrigin but an unparseable/absent URL falls back to a slug-derived host. */
export function tenantOriginOr(
  c: Pick<AdapterCompany, "tenantUrl" | "careersUrl" | "slug">,
  fallback: (slug: string) => string,
): string {
  try {
    return new URL(c.tenantUrl ?? c.careersUrl).origin;
  } catch {
    return fallback(c.slug);
  }
}

// Workday returns relative date strings like "Posted Today" / "5 Days Ago".
export function parsePostedOn(s: string | null): string | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  const now = new Date();

  if (lc.includes("today") || lc.includes("just")) {
    return now.toISOString();
  }
  if (lc.includes("yesterday")) {
    return new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  }
  const m = lc.match(/(\d+)\s*\+?\s*(day|week|month)s?\s*ago/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    return new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  }
  return null;
}
