import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import type { AdapterCompany } from "../types.js";

export const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|virtual)\b/i;

export const INTER_PAGE_DELAY_MS = 150;

export { sleep };

const PAGE_WARN_INTERVAL = 100;

export function warnDeepPagination(provider: string, slug: string, pagesDone: number, jobsSoFar: number): void {
  if (pagesDone % PAGE_WARN_INTERVAL === 0) {
    logger.warn({ slug, pages: pagesDone, jobsSoFar }, `${provider} pagination still going — unusually large tenant`);
  }
}

// Backstop for tenants whose `total` is unreliable and never return a short/empty page; high so no real board is truncated.
export const DEFAULT_MAX_PAGES = 5000;

export interface PaginationStallReport {
  level: "warn" | "info";
  message: string;
}

/** Warn only when the collected count fell short of a reported total; otherwise info. */
export function describePaginationStall(state: {
  total: number | null;
  collected: number;
  /** True only when the response proved there is no pager (e.g. gohire below one page); absent means unknown. */
  noPaginationControl?: boolean;
}): PaginationStallReport {
  const { total, collected } = state;
  if (total !== null && collected < total) {
    return {
      level: "warn",
      message: `pagination stalled short of the reported total - collected ${collected} of ${total} (board re-served the previous page instead of advancing)`,
    };
  }
  if (state.noPaginationControl === true) {
    return {
      level: "info",
      message: `pagination ended: board has no pagination control, so a single page is the whole board - collected ${collected}`,
    };
  }
  if (total === null) {
    return {
      level: "info",
      message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected}, and with no total exposed completeness is unverifiable`,
    };
  }
  return {
    level: "info",
    message: `pagination ended: board re-served the last page instead of returning empty - collected ${collected} of ${total} reported`,
  };
}

/** `rawCount` is the pre-filter record count; offset advance and short-page detection use it so filtered-out records don't shift the next offset. */
export interface PaginatePage<T> {
  items: T[];
  total: number | null;
  rawCount?: number;
  noPaginationControl?: boolean;
}

export interface PaginateOpts<T> {
  provider: string;
  company: string;
  /** Pass "infer" when page size is per-tenant (SuccessFactors serves 10 or 25); the first page's count becomes the size. */
  pageSize: number | "infer";
  maxPages?: number;
  /** False for tenants (e.g. Phenom) that may serve a short non-final page; they end on a zero-item page or reaching total. */
  shortPageEndsPagination?: boolean;
  interPageDelayMs?: number;
  fetchPage: (offset: number, page: number) => Promise<PaginatePage<T>>;
  /** Filter only: rawCount/items.length drive offset advance and termination, so duplicates never shift later offsets. */
  dedupeBy?: (item: T) => string;
}

export async function paginate<T>(opts: PaginateOpts<T>): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const shortPageEndsPagination = opts.shortPageEndsPagination ?? true;
  const interPageDelayMs = opts.interPageDelayMs ?? INTER_PAGE_DELAY_MS;
  const dedupeBy = opts.dedupeBy;
  let pageSize: number | null = opts.pageSize === "infer" ? null : opts.pageSize;
  const out: T[] = [];
  const seenKeys = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  let page = 0;
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

    if (total === null && typeof pageTotal === "number") {
      total = pageTotal;
    }

    // Stop only on an EXACT repeat of the prior page: a weaker signal would truncate boards that legitimately re-serve earlier rows.
    const signature = dedupeBy ? items.map(dedupeBy).join("\u0000") : null;
    if (signature !== null && items.length > 0 && added === 0 && signature === prevSignature) {
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
    // Under "infer" the first page can't be judged short against itself; guessing high would truncate page 1.
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

export function joinLocation(...parts: Array<string | null | undefined>): string | null {
  const joined = parts.map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
  return joined || null;
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function extractBalanced(text: string, startMarker: string, open: "[" | "{"): string | null {
  const markerAt = text.indexOf(startMarker);
  if (markerAt < 0) return null;
  const start = text.indexOf(open, markerAt + startMarker.length);
  if (start < 0) return null;
  const close = open === "[" ? "]" : "}";

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
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

export function dateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function epochMsToIso(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

export function tenantOrigin(c: Pick<AdapterCompany, "tenantUrl" | "careersUrl">): string {
  return new URL(c.tenantUrl ?? c.careersUrl).origin;
}

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

// Workday returns relative dates like "Posted Today" / "5 Days Ago".
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
