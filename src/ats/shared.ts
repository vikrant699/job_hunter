import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import type { AdapterCompany } from "../types.js";

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

// Backstop against a tenant whose `total` is unreliable AND never returns a
// short/empty page (would otherwise loop forever). Set high enough that no real
// board is ever truncated — completeness matters more than the safety margin,
// so we fetch every page and only this runaway guard can stop us early (it
// logs loudly via warnDeepPagination well before here, and once more if the
// cap itself is what ends the loop — see `paginate`).
export const DEFAULT_MAX_PAGES = 5000;

/**
 * Result of fetching one page: its items and, if known, the total item count
 * reported by the API. `rawCount`, if given, is the number of records the
 * server actually returned before any adapter-side filtering (e.g. Phenom
 * drops postings with no stable id) — pagination advances and short-page
 * detection use this instead of `items.length` so filtered-out records don't
 * cause the next page to be re-fetched at the wrong offset. Defaults to
 * `items.length`.
 */
export interface PaginatePage<T> {
  items: T[];
  total: number | null;
  rawCount?: number;
}

export interface PaginateOpts<T> {
  /** Adapter name, used only for the deep-pagination warn log line. */
  provider: string;
  /** Company slug, used only for the deep-pagination warn log line. */
  company: string;
  /** Expected page size — a page shorter than this ends the loop. */
  pageSize: number;
  /** Runaway backstop on page count, for a tenant whose `total` is unreliable
   *  and never returns a short/empty page. Default 5000 — high enough never to
   *  truncate a real board. */
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
   * Delay between page fetches, in ms. Defaults to `INTER_PAGE_DELAY_MS`.
   * Tests pass 0 to avoid paying the real politeness delay; adapters should
   * leave this unset so production behavior is unchanged.
   */
  interPageDelayMs?: number;
  /**
   * Fetch one page at the given offset (0-based, page-th call). Return its
   * items and, if known, the total item count reported by the API. See
   * `PaginatePage` for field semantics.
   */
  fetchPage: (offset: number, page: number) => Promise<PaginatePage<T>>;
  /**
   * When given, drops any item whose key (per this function) was already
   * accumulated on an earlier page — for tenants whose pages can overlap
   * (e.g. a job moves between two pages while the crawl is in flight).
   * Purely a filter on what's ACCUMULATED: `rawCount`/`items.length` (and
   * therefore the offset advance and short-page/total termination checks)
   * are computed from the page exactly as fetched, so duplicates never shift
   * later offsets.
   */
  dedupeBy?: (item: T) => string;
}

/**
 * Shared offset-pagination loop for the ATS adapters (Workday, SmartRecruiters,
 * Eightfold, Oracle, Phenom). All five fetch a page, accumulate items, and stop
 * on the first of: a zero-item page, (usually) a short page, a first-seen
 * `total` being reached, or a hard page cap. The offset always advances by the
 * number of items actually received (not a fixed page size) — equivalent to
 * advancing by `pageSize` for full pages, but also correct for tenants whose
 * server may return fewer items than requested for a given call. Reaching the
 * hard page cap (as opposed to any of the other stop conditions) logs a
 * runaway-cap warning, since it means the board may have been truncated.
 */
export async function paginate<T>(opts: PaginateOpts<T>): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const shortPageEndsPagination = opts.shortPageEndsPagination ?? true;
  const interPageDelayMs = opts.interPageDelayMs ?? INTER_PAGE_DELAY_MS;
  const dedupeBy = opts.dedupeBy;
  const out: T[] = [];
  const seenKeys = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  let page = 0;

  for (; page < maxPages; page++) {
    const { items, total: pageTotal, rawCount } = await opts.fetchPage(offset, page);
    if (dedupeBy) {
      for (const item of items) {
        const key = dedupeBy(item);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          out.push(item);
        }
      }
    } else {
      out.push(...items);
    }
    const count = rawCount ?? items.length;

    if (total === null && typeof pageTotal === "number") {
      total = pageTotal;
    }

    if (count === 0) break;
    if (shortPageEndsPagination && count < opts.pageSize) break;
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

/** Origin of the tenant's board: tenant_url wins, else careers_url. Throws on
 *  an unparseable URL (config error worth failing the company). */
export function tenantOrigin(c: Pick<AdapterCompany, "tenantUrl" | "careersUrl">): string {
  return new URL(c.tenantUrl ?? c.careersUrl).origin;
}

/** Like tenantOrigin but an unparseable/absent URL falls back to a
 *  slug-derived host. */
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
