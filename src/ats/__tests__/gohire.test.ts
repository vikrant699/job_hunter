// src/ats/gohire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gohireBoardUrl,
  gohireExternalId,
  parseGohireListPage,
  gohireAdapter,
} from "../gohire.js";
import { logger } from "../../logger.js";
import type { AdapterCompany, NormalizedPosting } from "../../types.js";

const company: AdapterCompany = {
  provider: "gohire",
  slug: "ikigai-infotech-llp-saleshandy-ilt9kdxu",
  name: "Ikigai Infotech LLP (Saleshandy)",
  careersUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  tenantUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  apiMeta: null,
};

// Trimmed real markup from POST https://jobs.gohire.io/<tenant>/ (page 1 of 3, 25 total).
const LIST_PAGE_1 = `
<div class="jobs">
  <div class="job-container">
    <a class="gohire-job" href="https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">Senior Content Marketer</h3></div>
        <div class="career-location"><p class="careers-location">Ahmedabad, India</p></div>
      </div>
      <p class="date-posted">Posted 24 June, 2026</p>
    </a>
    <a class="gohire-job" href="https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/sdet-2-manual-automation-291946/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">SDET-2 (Manual + Automation)</h3></div>
        <div class="career-location"><p class="careers-location">Remote, India</p></div>
      </div>
      <p class="date-posted">Posted 16 June, 2026</p>
    </a>
  </div>
  <div class="jobs-pagination"><p class="gohire-job-pagination-results">Page <strong>1</strong> of <strong>3</strong>, Total <strong>25</strong> jobs</p></div>
</div>`;

const LIST_PAGE_EMPTY = `
<div class="jobs">
  <div class="job-container"></div>
  <div class="jobs-pagination"><p class="gohire-job-pagination-results">Page <strong>4</strong> of <strong>3</strong>, Total <strong>25</strong> jobs</p></div>
</div>`;

// Verbatim pagination block from POST https://jobs.gohire.io/
// ikigai-infotech-llp-saleshandy-ilt9kdxu/ on 2026-08-04, whitespace and all.
// The counts it prints are the board's truth: it served 10 + 10 + 6 = 26 cards
// across its 3 pages, exactly the 26 claimed here.
const REAL_PAGER_BLOCK = `<div class="jobs-pagination gohire-job-pagination no-text-highlight jobBoard"><div class="gohire-job-pagination-buttons"><button type="button" disabled>Prev</button><button type="button" onclick="submitPaging('rightArrow', 1);">Next</button></div><p class="gohire-job-pagination-results">Page <strong>1</strong> of <strong>3</strong>, Total <strong>26</strong> jobs</p></div>`;

/** A list page holding `cards` plus a pager claiming `page` of `totalPages`
 *  and `totalJobs` total — the real element's tag/class/nesting. */
function pagedListPage(
  cards: string[],
  page: number,
  totalPages: number,
  totalJobs: number,
): string {
  return `<div class="jobs"><div class="job-container">${cards.join("")}</div>`
    + `<div class="jobs-pagination gohire-job-pagination no-text-highlight jobBoard">`
    + `<div class="gohire-job-pagination-buttons"><button type="button" disabled>Prev</button></div>`
    + `<p class="gohire-job-pagination-results">Page <strong>${page}</strong> of <strong>${totalPages}</strong>, `
    + `Total <strong>${totalJobs}</strong> jobs</p></div></div>`;
}

/** `count` well-formed cards with ids starting at `startId`, plus a pager. */
function pagedPageOf(count: number, startId: number, page: number, totalPages: number, totalJobs: number): string {
  return pagedListPage(Array.from({ length: count }, (_, i) => fullCard(startId + i)), page, totalPages, totalJobs);
}

// Trimmed real JSON-LD island from a job detail page.
const DETAIL_PAGE = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{
  "@context": "http:\\/\\/schema.org\\/",
  "@type": "JobPosting",
  "title": "Senior Content Marketer",
  "datePosted": "2026-06-24",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "@type": "Organization", "name": "Ikigai Infotech LLP (Saleshandy)" },
  "jobLocation": {
    "@type": "Place",
    "address": { "@type": "PostalAddress", "addressLocality": "Ahmedabad", "addressRegion": "Gujarat", "addressCountry": "India" }
  },
  "description": "About the role<br>Saleshandy is a cold email platform. <b>What you'll do</b> build content.",
  "baseSalary": { "@type": "MonetaryAmount", "currency": "INR", "value": { "@type": "QuantitativeValue", "minValue": 600000, "maxValue": 1000000, "unitText": "YEAR" } }
}
</script>
</head><body></body></html>`;

const MALFORMED_LIST = `<div class="jobs"><p>Something went wrong.</p></div>`;
const MALFORMED_DETAIL = `<!DOCTYPE html><html><head><title>x</title></head><body>no ld+json here</body></html>`;

// A full 10-card page — matches the real page size, so the pagination loop's
// short-page check doesn't end it early; only the next (empty) page does.
function fullCard(n: number): string {
  return `<a class="gohire-job" href="https://jobs.gohire.io/${company.slug}/job-${n}-${1000 + n}/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">Job ${n}</h3></div>
        <div class="career-location"><p class="careers-location">Ahmedabad, India</p></div>
      </div>
      <p class="date-posted">Posted 24 June, 2026</p>
    </a>`;
}
const LIST_PAGE_FULL = `<div class="jobs"><div class="job-container">${Array.from({ length: 10 }, (_, i) => fullCard(i + 1)).join("")}</div></div>`;

/** A card whose href carries no trailing numeric id — rendered by the server
 *  (so it counts toward the page's raw size) but dropped by the parser. */
function malformedCard(n: number): string {
  return `<a class="gohire-job" href="https://jobs.gohire.io/${company.slug}/broken-role/">
      <div class="left-career">
        <div class="career-title"><h3 class="job-title client-brand-text notranslate">Broken ${n}</h3></div>
      </div>
    </a>`;
}

/** A list page holding exactly the given cards. */
function listPage(cards: string[]): string {
  return `<div class="jobs"><div class="job-container">${cards.join("")}</div></div>`;
}

/** `count` well-formed cards with ids starting at `startId`. */
function pageOf(count: number, startId: number): string {
  return listPage(Array.from({ length: count }, (_, i) => fullCard(startId + i)));
}

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Serve a canned page per `page` form field; any page past the end is the
 *  empty board page. Records the page numbers requested, in order. */
function stubPages(pages: Record<string, string>): string[] {
  const seen: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const page = new URLSearchParams(body).get("page") ?? "";
    seen.push(page);
    return new Response(pages[page] ?? LIST_PAGE_EMPTY, { status: 200 });
  });
  return seen;
}

test("gohireBoardUrl builds the POST target from the tenant slug", () => {
  assert.equal(
    gohireBoardUrl(company),
    "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/",
  );
});

test("gohireExternalId extracts the trailing numeric id from a job-slug href", () => {
  assert.equal(
    gohireExternalId("https://jobs.gohire.io/tenant/senior-content-marketer-292750/"),
    "292750",
  );
  assert.equal(gohireExternalId("https://jobs.gohire.io/tenant/senior-content-marketer-292750"), "292750");
});

test("gohireExternalId returns null for a href with no trailing numeric id", () => {
  assert.equal(gohireExternalId("https://jobs.gohire.io/tenant/"), null);
});

test("parseGohireListPage extracts both cards: title, location, url, posted date", () => {
  const { postings: items, rawCount } = parseGohireListPage(LIST_PAGE_1, company);
  assert.equal(items.length, 2);
  assert.equal(rawCount, 2, "both cards were rendered and both parsed");

  const first = items[0];
  const second = items[1];
  assert.ok(first && second, "both cards parsed");
  assert.equal(first.provider, "gohire");
  assert.equal(first.externalId, "292750");
  assert.equal(first.jobTitle, "Senior Content Marketer");
  assert.equal(first.jobUrl, "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/");
  assert.equal(first.location, "Ahmedabad, India");
  assert.equal(first.isRemote, false);
  assert.equal(first.jdText, "");
  assert.equal(first.postedAt, new Date("24 June, 2026").toISOString());

  assert.equal(second.externalId, "291946");
  assert.equal(second.location, "Remote, India");
  assert.equal(second.isRemote, true);
});

test("parseGohireListPage returns an empty array for a page with no job cards", () => {
  assert.deepEqual(parseGohireListPage(LIST_PAGE_EMPTY, company), {
    postings: [],
    rawCount: 0,
    pager: { kind: "present", page: 4, totalPages: 3, totalJobs: 25 },
  });
});

test("parseGohireListPage returns an empty array for malformed/unexpected markup", () => {
  assert.deepEqual(parseGohireListPage(MALFORMED_LIST, company), {
    postings: [],
    rawCount: 0,
    pager: { kind: "absent" },
  });
});

test("parseGohireListPage reads the board's own totals out of the real pagination block", () => {
  // The whole point: gohire DOES publish a total, so a genuine truncation can
  // be measured instead of shrugged at. The counts must come from the pager,
  // not from the cards on the page (2 here vs the 26 the board reports).
  const { postings, rawCount, pager } = parseGohireListPage(
    `<div class="jobs"><div class="job-container">${fullCard(1)}${fullCard(2)}</div>${REAL_PAGER_BLOCK}</div>`,
    company,
  );
  assert.equal(postings.length, 2);
  assert.equal(rawCount, 2);
  assert.deepEqual(pager, { kind: "present", page: 1, totalPages: 3, totalJobs: 26 });
});

test("parseGohireListPage reads the pager through arbitrary markup and whitespace", () => {
  // The numbers arrive wrapped in <strong> today; nothing guarantees that stays
  // put. Parse the element's TEXT, so a different tag, extra nesting, or a
  // line-wrapped render all still read.
  const html = `<div class="jobs"><div class="job-container">${fullCard(1)}</div>
    <section class="jobs-pagination">
      <span class="gohire-job-pagination-results">
        Page <em><b>2</b></em>
        of <span>17</span>,
        Total  <i>168</i>  job
      </span>
    </section></div>`;
  assert.deepEqual(parseGohireListPage(html, company).pager, {
    kind: "present",
    page: 2,
    totalPages: 17,
    totalJobs: 168,
  });
});

test("parseGohireListPage reports an absent pager as absent — not zero, not a throw", () => {
  // Real single-page board (jobs.gohire.io/edwisely-ytgpsptj/, 2026-08-04):
  // gohire renders NO pagination block at all below one page — not an empty
  // one. Absence is therefore positive evidence that this page is the whole
  // board, which is what lets the stall log say something true.
  const html = `<div class="jobs">
  <div class="job-container">
<a class="gohire-job" href="https://jobs.gohire.io/edwisely-ytgpsptj/video-editor-and-multimedia-designer-294211/">
                <div class="left-career">
                    <div class="career-title">
                        <h3 class="job-title client-brand-text notranslate">Video Editor &amp; Multimedia Designer</h3>
                    </div>
                    <div class="career-location">
                        <p class="careers-location">Hyderabad, India</p>
                    </div>
                </div>
                <p class="date-posted">Posted 8 July, 2026</p>
            </a>
        <a class="gohire-job" href="https://jobs.gohire.io/edwisely-ytgpsptj/customer-success-manager-293459/">
                <div class="left-career">
                    <div class="career-title">
                        <h3 class="job-title client-brand-text notranslate">Customer Success Manager</h3>
                    </div>
                </div>
            </a>
  </div>
</div>`;
  const { postings, pager } = parseGohireListPage(html, company);
  assert.equal(postings.length, 2, "the cards still parse");
  assert.deepEqual(pager, { kind: "absent" });
});

test("parseGohireListPage refuses to guess when the pager is there but unreadable", () => {
  // A pager whose numbers we cannot read proves nothing either way, and must
  // not be collapsed into "absent" — that would claim a single-page board on
  // no evidence and hide a real truncation in the quiet log branch.
  const partial = `<div class="jobs"><div class="job-container">${fullCard(1)}</div>`
    + `<p class="gohire-job-pagination-results">Page <strong>1</strong> of <strong>3</strong></p></div>`;
  assert.deepEqual(parseGohireListPage(partial, company).pager, { kind: "unparsed" });

  const garbled = `<div class="jobs"><div class="job-container">${fullCard(1)}</div>`
    + `<p class="gohire-job-pagination-results">Showing some of the jobs</p></div>`;
  assert.deepEqual(parseGohireListPage(garbled, company).pager, { kind: "unparsed" });
});

test("parseGohireListPage reports the server's card count even when a card is unparseable", () => {
  // rawCount is the page's real size; postings is what survived. Pagination
  // must not read the gap between them as "the last page".
  const html = listPage([fullCard(1), malformedCard(2), fullCard(3)]);
  const { postings, rawCount } = parseGohireListPage(html, company);
  assert.equal(rawCount, 3);
  assert.deepEqual(postings.map((p) => p.externalId), ["1001", "1003"]);
});

/** One captured log call: the level is the whole point of the stall report. */
interface LogCall {
  level: "warn" | "info";
  fields: unknown;
  message: string | undefined;
}

/**
 * Run `fn` with the shared logger's level methods swapped for recorders.
 *
 * `paginate` logs through the module-scoped pino instance and there is no
 * injection point, but pino's level methods are ordinary writable properties —
 * so borrow them for the duration of one call and hand them back in a finally.
 * Worth the reach: the level and wording of this line ARE the feature.
 */
async function captureLogs(fn: () => Promise<void>): Promise<LogCall[]> {
  const calls: LogCall[] = [];
  const realWarn = logger.warn;
  const realInfo = logger.info;
  logger.warn = (fields: unknown, message?: string) => { calls.push({ level: "warn", fields, message }); };
  logger.info = (fields: unknown, message?: string) => { calls.push({ level: "info", fields, message }); };
  try {
    await fn();
  } finally {
    logger.warn = realWarn;
    logger.info = realInfo;
  }
  return calls;
}

/** The one stall line among the captured logs. */
function onlyStallLog(calls: LogCall[]): LogCall {
  const stalls = calls.filter((c) => typeof c.message === "string" && c.message.startsWith("pagination"));
  assert.equal(stalls.length, 1, `expected exactly one pagination log line, got ${JSON.stringify(calls)}`);
  const stall = stalls[0];
  assert.ok(stall);
  return stall;
}

test("gohireAdapter.listPostings feeds the pager's total into pagination", async () => {
  // Two full pages of 10 against a pager that says 20: reaching the reported
  // total is what ends the crawl, so page 3 is never asked for. Before the
  // pager was parsed the total was always null and this board cost an extra
  // fetch (and a stall) to terminate.
  const seen = stubPages({
    "1": pagedPageOf(10, 1, 1, 2, 20),
    "2": pagedPageOf(10, 11, 2, 2, 20),
  });
  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 20);
    assert.deepEqual(seen, ["1", "2"], "the reported total terminated the crawl");
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings warns, naming both counts, when a stall falls short of the pager's total", async () => {
  // A board that re-serves page 1 while its own pager promises 40 jobs IS
  // losing rows — the case that used to land in the quiet branch because
  // gohire reported no total at all.
  const seen: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push(new URLSearchParams(body).get("page") ?? "");
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(pagedPageOf(10, 1, 1, 4, 40), { status: 200 });
  });
  let items: NormalizedPosting[] = [];
  const calls = await captureLogs(async () => {
    items = await gohireAdapter.listPostings(company);
  }).finally(restoreFetch);

  assert.equal(items.length, 10);
  assert.deepEqual(seen, ["1", "2"], "the break must not depend on the log level");
  const stall = onlyStallLog(calls);
  assert.equal(stall.level, "warn");
  assert.match(stall.message ?? "", /\b10\b/, "must name what we collected");
  assert.match(stall.message ?? "", /\b40\b/, "must name the total the board reported");
});

test("gohireAdapter.listPostings stays quiet on a stall when the board renders no pager at all", async () => {
  // The real single-page shape (5 of 6 live gohire boards on 2026-08-04): 3
  // cards, no pagination block, every page a byte-identical repeat. With no
  // pager to render, one page IS the board — say so, at info.
  const seen: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push(new URLSearchParams(body).get("page") ?? "");
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(pageOf(3, 1), { status: 200 });
  });
  let items: NormalizedPosting[] = [];
  const calls = await captureLogs(async () => {
    items = await gohireAdapter.listPostings(company);
  }).finally(restoreFetch);

  assert.equal(items.length, 3);
  assert.deepEqual(seen, ["1", "2"], "the break must not depend on the log level");
  const stall = onlyStallLog(calls);
  assert.equal(stall.level, "info");
  assert.match(stall.message ?? "", /no pagination control, so a single page is the whole board/);
  assert.doesNotMatch(stall.message ?? "", /unverifiable/, "an absent pager IS the evidence");
});

test("gohireAdapter.listPostings still hedges on a stall when the pager is present but unreadable", async () => {
  // Element there, numbers unreadable: no total to check against and no proof
  // the board is single-page either. The honest line is the old one.
  const unreadable = `<div class="jobs"><div class="job-container">`
    + `${Array.from({ length: 3 }, (_, i) => fullCard(i + 1)).join("")}</div>`
    + `<p class="gohire-job-pagination-results">Page <strong>1</strong></p></div>`;
  const seen: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push(new URLSearchParams(body).get("page") ?? "");
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(unreadable, { status: 200 });
  });
  let items: NormalizedPosting[] = [];
  const calls = await captureLogs(async () => {
    items = await gohireAdapter.listPostings(company);
  }).finally(restoreFetch);

  assert.equal(items.length, 3);
  assert.deepEqual(seen, ["1", "2"], "the break must not depend on the log level");
  const stall = onlyStallLog(calls);
  assert.equal(stall.level, "info");
  assert.match(stall.message ?? "", /unverifiable/);
  assert.doesNotMatch(stall.message ?? "", /no pagination control/);
});

const { fetchJd } = gohireAdapter;
assert(fetchJd);

test("gohireAdapter.fetchJd extracts the JSON-LD description and strips HTML", async () => {
  stubFetch(async () => new Response(DETAIL_PAGE, { status: 200 }));
  try {
    const posting: NormalizedPosting = {
      provider: "gohire",
      externalId: "292750",
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: "Senior Content Marketer",
      jobUrl: "https://jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/senior-content-marketer-292750/",
      location: "Ahmedabad, India",
      isRemote: false,
      jdText: "",
      postedAt: null,
    };
    const jd = await fetchJd(company, posting);
    assert.match(jd, /Saleshandy is a cold email platform/);
    assert.match(jd, /What you'll do build content/);
    assert.doesNotMatch(jd, /<br>|<b>/);
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.fetchJd returns an empty string when the detail page has no JSON-LD island", async () => {
  stubFetch(async () => new Response(MALFORMED_DETAIL, { status: 200 }));
  try {
    const posting: NormalizedPosting = {
      provider: "gohire",
      externalId: "1",
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: "x",
      jobUrl: "https://jobs.gohire.io/tenant/x-1/",
      location: null,
      isRemote: false,
      jdText: "",
      postedAt: null,
    };
    const jd = await fetchJd(company, posting);
    assert.equal(jd, "");
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings collects the whole board when the tenant pages below the assumed 10", async () => {
  // A tenant configured for 4 cards a page. A declared pageSize of 10 made
  // page 1 look short and stopped the board there — 4 of 10 postings, silently.
  const seen = stubPages({ "1": pageOf(4, 1), "2": pageOf(4, 5), "3": pageOf(2, 9) });
  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 10, "all three pages, not just the first");
    assert.deepEqual(seen, ["1", "2", "3"], "the 2-card page 3 is short vs the inferred 4 and ends it");
    assert.deepEqual(
      items.map((p) => p.externalId),
      Array.from({ length: 10 }, (_, i) => String(1001 + i)),
    );
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings is unchanged on a tenant that really does page at 10", async () => {
  // Regression guard: the inferred size must reproduce the old behaviour
  // exactly when the old constant happened to be right.
  const seen = stubPages({ "1": pageOf(10, 1), "2": pageOf(10, 11), "3": pageOf(3, 21) });
  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 23);
    assert.deepEqual(seen, ["1", "2", "3"], "stops on the genuinely short final page");
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings does not let an unparseable card on a full page end the board", async () => {
  // The parser drops a card with no numeric id, so a FULL page can surface
  // fewer postings than the server rendered. Judging "short page" on the
  // parsed count truncated the board mid-crawl; the raw card count is the
  // server's own page size and is what pagination must measure.
  const page2 = listPage([...Array.from({ length: 9 }, (_, i) => fullCard(11 + i)), malformedCard(20)]);
  const seen = stubPages({ "1": pageOf(10, 1), "2": page2, "3": pageOf(3, 21) });
  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 22, "10 + 9 parsed of 10 + 3 — page 3 must still be fetched");
    assert.deepEqual(seen, ["1", "2", "3"]);
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings stops on a board that ignores the page field and re-serves page 1", async () => {
  // Nothing else can stop this board: there is no total, and every page is
  // full so the short-page rule never fires. The exact-page-repeat stall guard
  // is the only terminator, and it needs a stable per-item key to see the
  // repeat.
  const seen: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const page = new URLSearchParams(body).get("page") ?? "";
    seen.push(page);
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(pageOf(10, 1), { status: 200 });
  });
  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 10, "the repeated page contributes nothing new");
    assert.deepEqual(seen, ["1", "2"], "one repeat is enough to prove the board ignores `page`");
  } finally {
    restoreFetch();
  }
});

test("gohireAdapter.listPostings paginates via POST form body and stops on an empty page", async () => {
  const requests: string[] = [];
  stubFetch(async (_input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push(body);
    const page = new URLSearchParams(body).get("page");
    if (page === "1") return new Response(LIST_PAGE_FULL, { status: 200 });
    return new Response(LIST_PAGE_EMPTY, { status: 200 });
  });

  try {
    const items = await gohireAdapter.listPostings(company);
    assert.equal(items.length, 10, "page 1's 10 cards, page 2 empty");
    assert.equal(requests.length, 2, "stops after the first empty page");
    assert.match(requests[0] ?? "", /page=1/);
    assert.match(requests[0] ?? "", /remoteDdValue=all_Id/);
    assert.match(requests[0] ?? "", /typeDdValue=0/);
    assert.match(requests[1] ?? "", /page=2/);
  } finally {
    restoreFetch();
  }
});
