import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  REMOTE_RE,
  unixToIso,
  dateToIso,
  epochMsToIso,
  parsePostedOn,
  paginate,
  describePaginationStall,
  INTER_PAGE_DELAY_MS,
  tenantOrigin,
  tenantOriginOr,
  joinLocation,
  collapseWs,
  extractBalanced,
} from "../shared.js";
import type { AdapterCompany } from "../../types.js";

function dayDelta(iso: string | null): number {
  assert.ok(iso !== null, "expected non-null ISO string");
  return Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
}

describe("REMOTE_RE", () => {
  it('matches "Remote"', () => assert.ok(REMOTE_RE.test("Remote")));
  it('matches "Work From Home"', () =>
    assert.ok(REMOTE_RE.test("Work From Home")));
  it('matches "WFH"', () => assert.ok(REMOTE_RE.test("WFH")));
  it('matches "Anywhere"', () => assert.ok(REMOTE_RE.test("Anywhere")));
  it('matches "Virtual Office"', () =>
    assert.ok(REMOTE_RE.test("Virtual Office")));
  it('does not match "On-site"', () => assert.ok(!REMOTE_RE.test("On-site")));
  it('does not match "Bengaluru"', () =>
    assert.ok(!REMOTE_RE.test("Bengaluru")));
  it('does not match "Promote"', () =>
    assert.ok(!REMOTE_RE.test("Promote")));
  it('does not match "Premote"', () =>
    assert.ok(!REMOTE_RE.test("Premote")));
});

describe("unixToIso", () => {
  it("converts epoch seconds to ISO string", () => {
    assert.strictEqual(
      unixToIso(1_700_000_000),
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });
  it("returns null for null", () => assert.strictEqual(unixToIso(null), null));
  it("returns null for undefined", () =>
    assert.strictEqual(unixToIso(undefined), null));
  it("returns null for 0", () => assert.strictEqual(unixToIso(0), null));
});

describe("dateToIso", () => {
  it("converts a Date.parse-able string to ISO", () => {
    assert.strictEqual(
      dateToIso("2026-06-02"),
      new Date(Date.parse("2026-06-02")).toISOString(),
    );
  });
  it("returns null for an unparseable string", () =>
    assert.strictEqual(dateToIso("not a date"), null));
  it("returns null for null", () => assert.strictEqual(dateToIso(null), null));
  it("returns null for undefined", () =>
    assert.strictEqual(dateToIso(undefined), null));
  it("returns null for an empty string", () =>
    assert.strictEqual(dateToIso(""), null));
});

describe("epochMsToIso", () => {
  it("converts positive epoch milliseconds to ISO", () => {
    assert.strictEqual(
      epochMsToIso(1_719_800_000_000),
      new Date(1_719_800_000_000).toISOString(),
    );
  });
  it("returns null for 0", () => assert.strictEqual(epochMsToIso(0), null));
  it("returns null for null", () =>
    assert.strictEqual(epochMsToIso(null), null));
  it("returns null for undefined", () =>
    assert.strictEqual(epochMsToIso(undefined), null));
});

const originCompany: AdapterCompany = {
  provider: "successfactors",
  slug: "acme",
  name: "Acme",
  careersUrl: "https://acme.example.com/careers",
  tenantUrl: null,
  apiMeta: null,
};

describe("tenantOrigin", () => {
  it("prefers tenantUrl's origin when set", () => {
    assert.strictEqual(
      tenantOrigin({ ...originCompany, tenantUrl: "https://tenant.acme.com/board?x=1" }),
      "https://tenant.acme.com",
    );
  });
  it("falls back to careersUrl's origin when tenantUrl is unset", () => {
    assert.strictEqual(tenantOrigin(originCompany), "https://acme.example.com");
  });
  it("throws on an unparseable URL", () => {
    assert.throws(() => tenantOrigin({ ...originCompany, careersUrl: "not a url" }));
  });
});

describe("tenantOriginOr", () => {
  const fallback = (slug: string) => `https://${slug}.fallback.example.com`;

  it("prefers tenantUrl's origin when set", () => {
    assert.strictEqual(
      tenantOriginOr({ ...originCompany, tenantUrl: "https://tenant.acme.com/board" }, fallback),
      "https://tenant.acme.com",
    );
  });
  it("falls back to careersUrl's origin when tenantUrl is unset", () => {
    assert.strictEqual(tenantOriginOr(originCompany, fallback), "https://acme.example.com");
  });
  it("calls the fallback on an unparseable URL instead of throwing", () => {
    assert.strictEqual(
      tenantOriginOr({ ...originCompany, careersUrl: "not a url" }, fallback),
      "https://acme.fallback.example.com",
    );
  });
});

describe("joinLocation", () => {
  it("joins non-blank parts with a comma", () => {
    assert.strictEqual(joinLocation("Pune", null, "India"), "Pune, India");
  });
  it("joins three non-blank parts", () => {
    assert.strictEqual(joinLocation("Pune", "MH", "India"), "Pune, MH, India");
  });
  it("trims each part before joining", () => {
    assert.strictEqual(joinLocation("  Pune  ", " India "), "Pune, India");
  });
  it("skips null and undefined parts", () => {
    assert.strictEqual(joinLocation(null, undefined, "India"), "India");
  });
  it("skips blank/whitespace-only parts", () => {
    assert.strictEqual(joinLocation("", "  ", "India"), "India");
  });
  it("returns null when every part is blank", () => {
    assert.strictEqual(joinLocation(null, undefined, "", "   "), null);
  });
  it("returns null for zero parts", () => {
    assert.strictEqual(joinLocation(), null);
  });
});

describe("collapseWs", () => {
  it("collapses whitespace runs to a single space", () => {
    assert.strictEqual(collapseWs("a    b"), "a b");
  });
  it("collapses tabs/newlines too", () => {
    assert.strictEqual(collapseWs("a\t\nb"), "a b");
  });
  it("trims leading/trailing whitespace", () => {
    assert.strictEqual(collapseWs("  a b  "), "a b");
  });
  it("returns an empty string for all-whitespace input", () => {
    assert.strictEqual(collapseWs("   "), "");
  });
  it("leaves already-clean text unchanged", () => {
    assert.strictEqual(collapseWs("a b c"), "a b c");
  });
});

describe("extractBalanced", () => {
  it("pulls a bracket-balanced array, ignoring brackets in strings", () => {
    const src = `foo const ROLES = [{ title: 'A]B', note: "x[y" }, { title: 'C' }]; bar`;
    const lit = extractBalanced(src, "const ROLES =", "[");
    assert.ok(lit);
    assert.equal(lit.startsWith("[{"), true);
    assert.equal(lit.endsWith("}]"), true);
  });

  it("handles object container + backtick strings (a brace inside a backtick string doesn't miscount)", () => {
    const src = "x jobData = { a: { t: `has } brace` }, b: { t: 'y' } } ;";
    const lit = extractBalanced(src, "jobData =", "{");
    assert.equal(lit, "{ a: { t: `has } brace` }, b: { t: 'y' } }");
  });

  it("returns null when the marker is absent", () => {
    assert.equal(extractBalanced("nothing here", "const X =", "["), null);
  });
});

describe("parsePostedOn", () => {
  it("returns null for null input", () =>
    assert.strictEqual(parsePostedOn(null), null));
  it("returns null for empty string", () =>
    assert.strictEqual(parsePostedOn(""), null));
  it("returns null for unrecognised garbage", () =>
    assert.strictEqual(parsePostedOn("garbage"), null));
  it('"Posted Today" => 0 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("Posted Today")), 0));
  it('"Posted Yesterday" => 1 day ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("Posted Yesterday")), 1));
  it('"5 Days Ago" => 5 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("5 Days Ago")), 5));
  it('"2 Weeks Ago" => 14 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("2 Weeks Ago")), 14));
  it('"3 Months Ago" => 90 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("3 Months Ago")), 90));
});

describe("paginate", () => {
  it("stops on a short page and accumulates items in order", async () => {
    const pages: Array<{ items: number[]; total: number | null }> = [
      { items: [1, 2], total: null },
      { items: [3], total: null },
    ];
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 2,
      interPageDelayMs: 0,
      fetchPage: async (offset) => {
        const page = pages[calls];
        calls++;
        assert.ok(page, `unexpected extra fetchPage call at offset ${offset}`);
        return page;
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2);
  });

  it("stops when the first-seen total is reached", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 2,
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        // Every page is "full" so only the total check can terminate the loop.
        if (calls === 1) return { items: [1, 2], total: 3 };
        if (calls === 2) return { items: [3, 4], total: 999 }; // ignored: total already latched at 3
        throw new Error("should not be called a third time");
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4]);
    assert.equal(calls, 2);
  });

  it("stops at the hard page cap", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 1,
      maxPages: 3,
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        return { items: [calls], total: null };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 3);
  });

  it("stops immediately on a zero-item first page", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 10,
      fetchPage: async () => {
        calls++;
        return { items: [], total: null };
      },
    });
    assert.deepEqual(result, []);
    assert.equal(calls, 1);
  });

  it("advances the offset by items received, not a fixed page size", async () => {
    const offsetsSeen: number[] = [];
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 5,
      // Phenom-style: a page can be capped below pageSize without that meaning "last page".
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        // Server caps each page at 3 despite pageSize 5, so termination must rely on total.
        if (offset === 0) return { items: [1, 2, 3], total: 6 };
        if (offset === 3) return { items: [4, 5, 6], total: 6 };
        throw new Error("should not be called again");
      },
    });
    assert.deepEqual(offsetsSeen, [0, 3]);
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
  });

  it("advances by rawCount (pre-filter) rather than items.length when some records are filtered out", async () => {
    const offsetsSeen: number[] = [];
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 3,
      interPageDelayMs: 0,
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        // 3 raw records per page, but one is filtered out (e.g. missing stable id), so items.length < rawCount.
        if (offset === 0) return { items: [1, 2], total: null, rawCount: 3 };
        if (offset === 3) return { items: [4], total: null, rawCount: 2 }; // short raw page -> stop
        throw new Error("should not be called again");
      },
    });
    assert.deepEqual(offsetsSeen, [0, 3]);
    assert.deepEqual(result, [1, 2, 4]);
  });

  it("stops when a board ignores the offset and re-serves the identical page", async () => {
    // Mirrors a tenant that ignores the offset and re-serves identical rows every page.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "stuck",
      pageSize: 10,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: 314, rawCount: 10 };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "must not walk all 32 pages");
  });

  it("does NOT truncate a board that re-serves seen rows but still has more", async () => {
    // Unstable ordering can re-serve a fully-duplicate page mid-run then resume with new ids; must not truncate on an all-seen page alone.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "reshuffles",
      pageSize: 2,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        if (calls === 1) return { items: [1, 2], total: 12, rawCount: 2 };
        if (calls === 2) return { items: [3, 4], total: 12, rawCount: 2 };
        // All-seen page, but NOT an exact repeat of page 2 -> must continue.
        if (calls === 3) return { items: [2, 3], total: 12, rawCount: 2 };
        if (calls === 4) return { items: [5, 6], total: 12, rawCount: 2 };
        if (calls === 5) return { items: [7, 8], total: 12, rawCount: 2 };
        return { items: [9, 10], total: 12, rawCount: 2 };
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "must keep going past a duplicate page");
    assert.equal(calls, 6);
  });

  it("does not mistake a genuinely-new page for a stall", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 2,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        if (calls === 1) return { items: [1, 2], total: 6 };
        if (calls === 2) return { items: [3, 4], total: 6 };
        return { items: [5, 6], total: 6 };
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
    assert.equal(calls, 3);
  });

  it("with shortPageEndsPagination disabled, a zero-item page still stops it", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 5,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        if (calls === 1) return { items: [1, 2, 3], total: null };
        return { items: [], total: null };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2);
  });

  it("still stops on a short page even when total is null", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 4,
      fetchPage: async () => {
        calls++;
        return { items: [1, 2], total: null };
      },
    });
    assert.deepEqual(result, [1, 2]);
    assert.equal(calls, 1);
  });

  it("zero total on the first page still bounds the loop", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 2,
      fetchPage: async (_offset) => {
        calls++;
        // total=0 on a full first page must stop immediately, not be treated as "not yet known".
        return { items: [1, 2], total: 0 };
      },
    });
    assert.deepEqual(result, [1, 2]);
    assert.equal(calls, 1);
  });

  it("dedupeBy skips items whose key was already seen on an earlier page, without disturbing offset advance", async () => {
    const offsetsSeen: number[] = [];
    const result = await paginate<{ id: string; n: number }>({
      provider: "test",
      company: "acme",
      pageSize: 2,
      interPageDelayMs: 0,
      dedupeBy: (item) => item.id,
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        if (offset === 0) return { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }], total: null };
        // "b" repeats (e.g. a job that moved pages while crawling) and must be dropped from the result.
        if (offset === 2) return { items: [{ id: "b", n: 2 }, { id: "c", n: 3 }], total: null };
        // Offset still advances by the raw page size (2), not the deduped count, so a duplicate never shifts later offsets.
        if (offset === 4) return { items: [{ id: "d", n: 4 }], total: null };
        throw new Error("should not be called again");
      },
    });
    assert.deepEqual(result.map((r) => r.id), ["a", "b", "c", "d"]);
    assert.deepEqual(offsetsSeen, [0, 2, 4]);
  });

  it("the cap-exit path (loop exhausts maxPages rather than breaking) still returns everything fetched", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 1,
      maxPages: 4,
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        // Every page is full and total stays unknown, so only maxPages ends the loop (the runaway-cap log line isn't spied on here).
        return { items: [calls], total: null };
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4]);
    assert.equal(calls, 4);
  });

  it("pageSize 'infer' learns the tenant's page size from its first page", async () => {
    // A real tenant serves 608 postings at 10 rows per page; a declared pageSize of 25 would look short and truncate it.
    const TOTAL = 608;
    const PER_PAGE = 10;
    const offsetsSeen: number[] = [];
    const result = await paginate<number>({
      provider: "test",
      company: "mahindra-group",
      pageSize: "infer",
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        const items = Array.from({ length: Math.min(PER_PAGE, TOTAL - offset) }, (_, i) => offset + i);
        return { items, total: TOTAL, rawCount: items.length };
      },
    });
    assert.equal(result.length, TOTAL);
    assert.equal(offsetsSeen.length, 61, "60 full pages plus an 8-row tail");
    assert.deepEqual(offsetsSeen.slice(0, 3), [0, 10, 20]);
    assert.equal(result[0], 0);
    assert.equal(result.at(-1), 607);
  });

  it("pageSize 'infer' still ends on a genuinely short final page when total is unknown", async () => {
    const offsetsSeen: number[] = [];
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: "infer",
      interPageDelayMs: 0,
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        if (offset === 0) return { items: [1, 2, 3, 4], total: null };
        if (offset === 4) return { items: [5, 6], total: null }; // short vs the inferred 4
        throw new Error("should not be called again");
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(offsetsSeen, [0, 4]);
  });

  it("pageSize 'infer' does not treat a board smaller than one page as a short page", async () => {
    // The first page DEFINES the page size, so it can never be "short"; a one-page board ends on the empty page after it.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: "infer",
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        if (calls === 1) return { items: [1, 2, 3], total: null };
        return { items: [], total: null };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2);
  });

  it("pageSize 'infer' still stops on a board that ignores the offset and repeats page 1", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "stuck",
      pageSize: "infer",
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: 608, rawCount: 10 };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "the stall guard must still fire without a declared page size");
  });

  it("the stall guard is inert without dedupeBy: a repeating board is then bounded only by the cap", async () => {
    // Without dedupeBy the stall guard has no per-item key, so an offset-ignoring board is bounded only by maxPages.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "stuck-no-key",
      pageSize: "infer",
      maxPages: 5,
      interPageDelayMs: 0,
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: null };
      },
    });
    assert.equal(calls, 5, "no key means no stall detection, so only the cap stops it");
    assert.equal(result.length, 15);
  });

  it("pageSize 'infer' with no total and an endless board is bounded by maxPages", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "endless",
      pageSize: "infer",
      maxPages: 4,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async (offset) => {
        calls++;
        return { items: Array.from({ length: 10 }, (_, i) => offset + i), total: null };
      },
    });
    assert.equal(calls, 4);
    assert.equal(result.length, 40);
  });

  it("defaults interPageDelayMs to INTER_PAGE_DELAY_MS when omitted", async () => {
    assert.equal(INTER_PAGE_DELAY_MS, 150);
    let calls = 0;
    const start = Date.now();
    // Deliberately omits interPageDelayMs to exercise the real default; kept to a single short page pair since it pays the actual delay.
    const result = await paginate<number>({
      provider: "test",
      company: "acme",
      pageSize: 1,
      fetchPage: async () => {
        calls++;
        if (calls === 1) return { items: [1], total: null };
        return { items: [], total: null };
      },
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, [1]);
    assert.equal(calls, 2);
    assert.ok(
      elapsed >= INTER_PAGE_DELAY_MS,
      `expected at least one ${INTER_PAGE_DELAY_MS}ms inter-page delay, took ${elapsed}ms`,
    );
  });

  // These three stall shapes differ only in the reported total, which decides the log level; the break (fetch count) stays identical.
  it("a stall short of the reported total stops on the repeat and is a warning", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "short-of-total",
      pageSize: 10,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: 314, rawCount: 10 };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "the break must not depend on the log level");
    assert.equal(
      describePaginationStall({ total: 314, collected: result.length }).level,
      "warn",
      "314 reported but 3 collected is real truncation",
    );
  });

  it("a stall on a board that exposes no total still stops, and is not a warning", async () => {
    // A small board can clamp at its last page, re-serving it if asked beyond the end; nothing suggests loss here.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "clamps-no-total",
      pageSize: 10,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: null, rawCount: 10 };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "the break must not depend on the log level");
    assert.equal(describePaginationStall({ total: null, collected: result.length }).level, "info");
  });

  it("a stall after collecting the whole reported total still stops, and is not a warning", async () => {
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "clamps-at-total",
      pageSize: 2,
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        // total=3 is reached by page 0's rows, but offset advances by rawCount (2), so one more page is fetched and repeats the last.
        if (calls === 1) return { items: [1, 2, 3], total: 3, rawCount: 2 };
        return { items: [1, 2, 3], total: 3, rawCount: 2 };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "the break must not depend on the log level");
    assert.equal(describePaginationStall({ total: 3, collected: result.length }).level, "info");
  });

  it("a page declaring no pagination control changes the log line, never the break", async () => {
    // The flag is reporting-only; it must not become a fourth stop condition.
    let calls = 0;
    const result = await paginate<number>({
      provider: "test",
      company: "no-pager",
      pageSize: 3,
      interPageDelayMs: 0,
      dedupeBy: (n) => String(n),
      fetchPage: async () => {
        calls++;
        return { items: [1, 2, 3], total: null, rawCount: 3, noPaginationControl: true };
      },
    });
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "same two fetches as the flagless clamp above");
  });
});

describe("describePaginationStall", () => {
  it("warns and names both counts when the collection fell short of the reported total", () => {
    const { level, message } = describePaginationStall({ total: 314, collected: 3 });
    assert.equal(level, "warn");
    assert.match(message, /\b3\b/, "must name what we collected");
    assert.match(message, /\b314\b/, "must name the reported total");
    assert.match(message, /short of the reported total/);
  });

  it("does not warn when no total was exposed, and says completeness is unverifiable", () => {
    const { level, message } = describePaginationStall({ total: null, collected: 3 });
    assert.equal(level, "info");
    assert.match(message, /unverifiable/);
    // Re-serving the last page is indistinguishable from ignoring the offset when only one page exists, so no cause is asserted.
    assert.doesNotMatch(message, /ignores the offset/);
  });

  it("does not warn when the whole reported total was collected", () => {
    const { level, message } = describePaginationStall({ total: 8, collected: 8 });
    assert.equal(level, "info");
    assert.match(message, /\b8\b/);
    assert.doesNotMatch(message, /unverifiable/, "a satisfied total IS evidence of completeness");
  });

  it("does not warn when more was collected than the reported total", () => {
    // Boards under-report (a stale count, or a facet the total ignores); more than promised is not a truncation.
    assert.equal(describePaginationStall({ total: 5, collected: 9 }).level, "info");
  });

  it("treats a zero total with nothing collected as complete, not short", () => {
    assert.equal(describePaginationStall({ total: 0, collected: 0 }).level, "info");
  });

  it("states plainly that a board with no pagination control is complete in one page", () => {
    // Not a hedge: absence of a pager element PROVES the single page is the whole board.
    const { level, message } = describePaginationStall({
      total: null,
      collected: 3,
      noPaginationControl: true,
    });
    assert.equal(level, "info");
    assert.match(message, /no pagination control, so a single page is the whole board/);
    assert.match(message, /\b3\b/, "must name what we collected");
    assert.doesNotMatch(message, /unverifiable/);
  });

  it("keeps hedging when nothing proved the board lacks a pagination control", () => {
    // The flag is positive evidence only; false (or absent) means "unknown".
    const { level, message } = describePaginationStall({
      total: null,
      collected: 3,
      noPaginationControl: false,
    });
    assert.equal(level, "info");
    assert.match(message, /unverifiable/);
    assert.doesNotMatch(message, /no pagination control/);
  });

  it("still warns about a shortfall even if the board also claims no pagination control", () => {
    // Contradictory inputs resolve toward the loud branch: a missed warning is the costlier mistake.
    const { level, message } = describePaginationStall({
      total: 40,
      collected: 10,
      noPaginationControl: true,
    });
    assert.equal(level, "warn");
    assert.match(message, /short of the reported total/);
    assert.match(message, /\b10\b/);
    assert.match(message, /\b40\b/);
  });
});
