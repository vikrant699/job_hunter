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
 * How to report an exact-repeat pagination stall: which level, and a message
 * that claims only what the numbers support.
 */
export interface PaginationStallReport {
  level: "warn" | "info";
  message: string;
}

/**
 * Decide how loudly to report an exact-repeat stall, given the total the board
 * reported (null if it exposes none) and how many items we ended up with.
 *
 * Split out as a pure function because the level is the whole point of the log
 * line and there is no injection point for the global logger — this is the part
 * worth pinning in tests.
 *
 * Only a collection that fell SHORT of a reported total is evidence that rows
 * were lost; that is the one case worth a warning. Otherwise the board simply
 * re-served its last page instead of returning an empty one (5 of 6 gohire
 * boards did exactly this on 2026-08-01, all of them complete), and shouting
 * every run would train us to ignore the line that finally matters.
 */
export function describePaginationStall(state: { total: number | null; collected: number }): PaginationStallReport {
  const { total, collected } = state;
  if (total !== null && collected < total) {
    return {
      level: "warn",
      message: `pagination stalled short of the reported total - collected ${collected} of ${total} (board re-served the previous page instead of advancing)`,
    };
  }
  if (total === null) {
    return {
      level: "info",
      // No total means no way to check: absence of evidence of loss, not
      // evidence of completeness. Say that rather than implying "all good".
      message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected}, and with no total exposed completeness is unverifiable`,
    };
  }
  return {
    level: "info",
    message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected} of ${total} reported`,
  };
}

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
  /**
   * Expected page size — a page shorter than this ends the loop. Pass "infer"
   * when the size is a property of the TENANT rather than of the engine: the
   * first page's own row count is taken as the page size instead of a guessed
   * constant. SuccessFactors serves 10 rows to one tenant and 25 to the next,
   * and declaring 25 truncated the 10-row tenants at page 1.
   */
  pageSize: number | "infer";
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
    const { items, total: pageTotal, rawCount } = await opts.fetchPage(offset, page);
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

    // Latched before the stall check below so that check can report the total,
    // including a total this page is the first to expose. Nothing else reads
    // `total` earlier in the iteration, so the loop behaves identically.
    if (total === null && typeof pageTotal === "number") {
      total = pageTotal;
    }

    // A board that ignores the offset parameter serves page 0 forever, so we
    // would walk all the way to `total` re-fetching identical rows:
    // godrej-agrovet (2026-07-26) returned the same 10 jobs across 32 pages,
    // turning 3 real postings into 96 JD fetches.
    //
    // The stop condition is an EXACT repeat of the previous page, not merely a
    // page whose rows have all been seen before. Boards with unstable ordering
    // legitimately re-serve rows from earlier pages while still having more to
    // give: idfcfirst (1530 hits) hands back a fully-duplicate page around
    // page 8 and then keeps yielding new ids for another ~1200. Treating that
    // as a stall truncated it to 324 — never truncate on a weaker signal.
    //
    // The same repeat also happens benignly: a board that CLAMPS at its last
    // page (gohire) re-serves it instead of returning empty, so stopping here
    // loses nothing. The two are indistinguishable from the response alone, so
    // only the counts decide how loud the log is — see describePaginationStall.
    const signature = dedupeBy ? items.map(dedupeBy).join("\u0000") : null;
    if (signature !== null && items.length > 0 && added === 0 && signature === prevSignature) {
      const stall = describePaginationStall({ total, collected: out.length });
      const where = {
        provider: opts.provider,
        company: opts.company,
        page,
        itemsSeen: items.length,
        kept: out.length,
        total,
      };
      if (stall.level === "warn") logger.warn(where, stall.message);
      else logger.info(where, stall.message);
      break;
    }
    prevSignature = signature;

    if (count === 0) break;
    // Under "infer" the first page IS the page size, so it can never be judged
    // short against itself — the only safe direction, since guessing high
    // truncates the board on page 1 while guessing low costs at most one extra
    // fetch before an empty page (or the total) ends the loop.
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

/** Slice out a bracket-balanced literal starting at the first `open` bracket
 *  after `startMarker`. Tracks string state so brackets inside quoted values
 *  (incl. backtick strings) don't miscount. Returns null if unbalanced. */
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
