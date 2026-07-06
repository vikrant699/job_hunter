import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";

export const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|virtual)\b/i;

/** Politeness delay between pagination requests, shared by all API adapters. */
export const INTER_PAGE_DELAY_MS = 150;

export { sleep };

// 100+ pages usually means either a termination bug or a genuinely huge board —
// either way worth a log line. Warn, don't stop.
const PAGE_WARN_INTERVAL = 100;

export function warnDeepPagination(provider: string, slug: string, pagesDone: number, jobsSoFar: number): void {
  if (pagesDone % PAGE_WARN_INTERVAL === 0) {
    logger.warn({ slug, pages: pagesDone, jobsSoFar }, `${provider} pagination still going — unusually large tenant`);
  }
}

const DEFAULT_MAX_PAGES = 200;

export interface PaginateOpts<T> {
  /** Adapter name, used only for the deep-pagination warn log line. */
  provider: string;
  /** Company slug, used only for the deep-pagination warn log line. */
  company: string;
  /** Expected page size — a page shorter than this ends the loop. */
  pageSize: number;
  /** Hard stop on page count, in case a tenant's `total` is unreliable. Default 200. */
  maxPages?: number;
  /**
   * Whether a page shorter than `pageSize` (but non-empty) ends pagination.
   * True for tenants whose page size is authoritative (Workday, SmartRecruiters,
   * Eightfold, Oracle). Some tenants (e.g. Phenom) may serve fewer items than
   * requested without that meaning "last page" — those pass `false` and rely
   * on a zero-item page or reaching `total` to terminate instead. Default true.
   */
  shortPageEndsPagination?: boolean;
  /**
   * Fetch one page at the given offset (0-based, page-th call). Return its
   * items and, if known, the total item count reported by the API.
   * `rawCount`, if given, is the number of records the server actually
   * returned before any adapter-side filtering (e.g. Phenom drops postings
   * with no stable id) — pagination advances and short-page detection use
   * this instead of `items.length` so filtered-out records don't cause the
   * next page to be re-fetched at the wrong offset. Defaults to `items.length`.
   */
  fetchPage: (offset: number, page: number) => Promise<{ items: T[]; total: number | null; rawCount?: number }>;
}

/**
 * Shared offset-pagination loop for the ATS adapters (Workday, SmartRecruiters,
 * Eightfold, Oracle, Phenom). All five fetch a page, accumulate items, and stop
 * on the first of: a zero-item page, (usually) a short page, a first-seen
 * `total` being reached, or a hard page cap. The offset always advances by the
 * number of items actually received (not a fixed page size) — equivalent to
 * advancing by `pageSize` for full pages, but also correct for tenants whose
 * server may return fewer items than requested for a given call.
 */
export async function paginate<T>(opts: PaginateOpts<T>): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const shortPageEndsPagination = opts.shortPageEndsPagination ?? true;
  const out: T[] = [];
  let offset = 0;
  let total: number | null = null;

  for (let page = 0; page < maxPages; page++) {
    const { items, total: pageTotal, rawCount } = await opts.fetchPage(offset, page);
    out.push(...items);
    const count = rawCount ?? items.length;

    if (total === null && typeof pageTotal === "number") {
      total = pageTotal;
    }

    if (count === 0) break;
    if (shortPageEndsPagination && count < opts.pageSize) break;
    offset += count;
    if (total !== null && offset >= total) break;

    warnDeepPagination(opts.provider, opts.company, page + 1, out.length);
    await sleep(INTER_PAGE_DELAY_MS);
  }

  return out;
}

export function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
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
