import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  REMOTE_RE,
  unixToIso,
  dateToIso,
  epochMsToIso,
  parsePostedOn,
  paginate,
  INTER_PAGE_DELAY_MS,
  tenantOrigin,
  tenantOriginOr,
  joinLocation,
  collapseWs,
  extractBalanced,
} from "./shared.js";
import type { AdapterCompany } from "../types.js";

// helper: days between a past ISO string and now
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
      { items: [3], total: null }, // short page (< pageSize 2) -> stop
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
        // Every page is "full" (length === pageSize) so only the total check
        // can terminate the loop.
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
      // Phenom-style: server may cap a page below pageSize without that
      // meaning "last page" — only a zero-item page or reaching total stops it.
      shortPageEndsPagination: false,
      interPageDelayMs: 0,
      fetchPage: async (offset) => {
        offsetsSeen.push(offset);
        // server caps each page at 3 items even though pageSize is 5 —
        // termination must rely on total, since 3 < 5 would otherwise stop early
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
        // Server returns 3 raw records each page, but one per page gets
        // filtered out by the adapter (e.g. missing stable id) -> items.length
        // is 2 even though the page was "full" at pageSize 3.
        if (offset === 0) return { items: [1, 2], total: null, rawCount: 3 };
        if (offset === 3) return { items: [4], total: null, rawCount: 2 }; // short raw page -> stop
        throw new Error("should not be called again");
      },
    });
    assert.deepEqual(offsetsSeen, [0, 3]);
    assert.deepEqual(result, [1, 2, 4]);
  });

  it("stops when a board ignores the offset and re-serves the same page", async () => {
    // The godrej-agrovet failure mode (2026-07-26): the tenant ignored `from`,
    // so every page returned the same rows and pagination walked to `total`
    // re-fetching them. 314 totalHits / 10 per page = 32 identical pages.
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
    // Page 0 keeps the rows; page 1 adds nothing new -> stop immediately.
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls, 2, "must not walk all 32 pages");
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
        // total=0 reported on a full first page: offset(0) >= total(0) must stop
        // immediately after this page rather than treating 0 as "not yet known".
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
        // "b" repeats here (e.g. a tenant re-listing a job that moved between
        // pages while crawling) - it must be dropped from the result...
        if (offset === 2) return { items: [{ id: "b", n: 2 }, { id: "c", n: 3 }], total: null };
        // ...but the offset still advances by the RAW page size (2 items
        // received), not the deduped output count, so this page is fetched
        // at offset 4, not 3 - a duplicate never shifts later offsets.
        if (offset === 4) return { items: [{ id: "d", n: 4 }], total: null }; // short page -> stop
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
        // Every page is full-size (never short) and total stays unknown, so
        // nothing inside the loop body ever breaks - the ONLY way this loop
        // ends is by exhausting maxPages, which is the branch that also logs
        // "pagination hit the runaway cap" via the global logger (not spied
        // on here - shared.ts has no injection point for it; this test pins
        // the functional half of the contract: the return is exactly the
        // maxPages worth of items, no more, no less).
        return { items: [calls], total: null };
      },
    });
    assert.deepEqual(result, [1, 2, 3, 4]);
    assert.equal(calls, 4);
  });

  it("defaults interPageDelayMs to INTER_PAGE_DELAY_MS when omitted", async () => {
    assert.equal(INTER_PAGE_DELAY_MS, 150);
    let calls = 0;
    const start = Date.now();
    // Deliberately omits interPageDelayMs to exercise the real default — the
    // only test in this suite that pays the actual politeness delay (one
    // inter-page sleep), so it stays a single short page pair.
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
});
