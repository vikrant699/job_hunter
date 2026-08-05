// src/ats/trakstar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trakstarListUrl,
  parseTrakstarHref,
  parseTrakstarList,
  parseTrakstarJd,
  trakstarAdapter,
} from "../trakstar.js";
import {
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "../../util/errorCause.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "trakstar",
  slug: "acme",
  name: "Acme Corp",
  careersUrl: "https://acme.hire.trakstar.com/",
  tenantUrl: "https://acme.hire.trakstar.com/",
  apiMeta: null,
};

// Trimmed real markup shape from GET / (three rows: one missing location, one
// duplicate slug to prove dedup).
const LIST_HTML = `
<html><body>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/business-analyst/">
      <h3 class="js-job-list-opening-name">Business Analyst</h3>
      <div class="meta-job-location-city">Bengaluru, India</div>
    </a>
  </div>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/software-engineer-remote/">
      <h3 class="js-job-list-opening-name">Software Engineer (Remote)</h3>
    </a>
  </div>
  <div class="js-careers-page-job-list-item">
    <a href="/jobs/business-analyst/">
      <h3 class="js-job-list-opening-name">Business Analyst</h3>
      <div class="meta-job-location-city">Bengaluru, India</div>
    </a>
  </div>
</body></html>
`;

const JD_HTML = `
<html><body>
  <div class="jobdesciption">
    <div><strong>Roles &amp; Responsibilities.<br></strong>* Track business numbers<br>* Build dashboards<br></div>
  </div>
</body></html>
`;

// Trimmed from GET https://medibuddy.hire.trakstar.com/ (HTTP 200, 85,331
// bytes, captured 2026-08-02) — a cancelled tenant. The board is gone and
// Trakstar's marketing site is served in its place, headed by the inactive
// notice. Note the empty <title> and the canonical pointing at Trakstar's own
// shared /inactive-ats page rather than at the tenant.
const INACTIVE_ACCOUNT_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title></title>
    <link rel="canonical" href="https://recruiterbox.com/inactive-ats">
  </head>
  <body>
    <div class="bg-gray-6">
      <div class="container-fluid">
        <div class="row content-container">
          <div class="col-md-12">
            <a title="Trakstar Hire: Recruitment Software, Applicant Tracking" class="navbar-brand" href="https://recruiterbox.com/">
              <span class="logo-text">Trakstar Hire</span>
            </a>
          </div>
        </div>
        <div class="row content-container">
          <div class="col-sm-offset-1 col-sm-10">
            <div class="bg-white error-content-well tmrgn-40px bmrgn-64px">
              <img src="/static/images/marketing/product/error.svg">
              <div style="margin-left: 24px;">
                <h3 style="margin-bottom: 0;">Inactive account.</h3>
                <p>This employer is no longer using Trakstar Hire to collect applications. Please contact the employer directly for information on how to apply.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="bg-white text-center tpdng-40px bpdng-40px">
      <h1>Trakstar Hire Applicant Tracking System for Growing Businesses</h1>
    </div>
  </body>
</html>
`;

// A LIVE tenant with nothing open: real careers chrome (heading, blurb, the
// job-alert signup every serving board carries), just no rows. Shape taken
// from a serving board with its single job item removed. No canonical link —
// serving boards emit none. This is the case the check must not swallow.
const EMPTY_BOARD_HTML = `<!DOCTYPE html>
<html>
  <head><title>Acme Corp jobs | Acme Corp openings | Acme Corp careers</title></head>
  <body>
    <div class="js-careers-page">
      <h1>Jobs at Acme Corp</h1>
      <p>Hi, Welcome to our Careers section. Please review the positions we are currently hiring for and apply to the ones that interest you.</p>
      <div class="js-careers-page-job-list"></div>
      <div class="careers-page-subscribe">
        <p>Couldn't find the opening you were looking for?</p>
        <p>Get updates about new opportunities straight to your inbox</p>
        <form><input type="email" placeholder="Email address"><button>Keep me posted</button></form>
      </div>
      <footer>powered by Trakstar Hire</footer>
    </div>
  </body>
</html>
`;

test("trakstarListUrl derives the tenant origin for page 1 (bare origin)", () => {
  assert.equal(trakstarListUrl(company), "https://acme.hire.trakstar.com");
  assert.equal(
    trakstarListUrl({ ...company, tenantUrl: null }),
    "https://acme.hire.trakstar.com",
  );
});

test("parseTrakstarHref extracts the slug from a /jobs/<slug>/ path", () => {
  assert.deepEqual(parseTrakstarHref("/jobs/business-analyst/"), { slug: "business-analyst" });
  assert.deepEqual(parseTrakstarHref("/jobs/business-analyst/?src=x"), {
    slug: "business-analyst",
  });
  assert.equal(parseTrakstarHref("/jobs/"), null);
  assert.equal(parseTrakstarHref("/careers/business-analyst/"), null);
});

test("parseTrakstarList maps rows: title, location (tolerating absence), isRemote, absolute URL, and dedups by slug", () => {
  const postings = parseTrakstarList(LIST_HTML, company);
  assert.equal(postings.length, 2);

  const [ba, se] = postings;
  assert.equal(ba?.provider, "trakstar");
  assert.equal(ba.externalId, "business-analyst");
  assert.equal(ba.jobTitle, "Business Analyst");
  assert.equal(ba.jobUrl, "https://acme.hire.trakstar.com/jobs/business-analyst/");
  assert.equal(ba.location, "Bengaluru, India");
  assert.equal(ba.isRemote, false);
  assert.equal(ba.jdText, "");
  assert.equal(ba.postedAt, null);

  assert.equal(se?.externalId, "software-engineer-remote");
  assert.equal(se.jobTitle, "Software Engineer (Remote)");
  assert.equal(se.location, null);
  assert.equal(se.isRemote, false);
});

test("parseTrakstarList detects remote via REMOTE_RE on the location text", () => {
  const remoteHtml = `
    <div class="js-careers-page-job-list-item">
      <a href="/jobs/remote-role/">
        <h3 class="js-job-list-opening-name">Remote Role</h3>
        <div class="meta-job-location-city">Remote</div>
      </a>
    </div>`;
  const postings = parseTrakstarList(remoteHtml, company);
  assert.equal(postings[0]?.isRemote, true);
});

test("parseTrakstarList returns [] when there are no job-list-item rows (empty board / layout change)", () => {
  assert.deepEqual(parseTrakstarList("<html><body>No jobs right now.</body></html>", company), []);
});

// --- cancelled tenant vs empty board -------------------------------------------

/** Run `fn` and hand back whatever it threw, failing the test if it returned. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

test("parseTrakstarList throws on Trakstar's inactive-account page instead of reporting an empty board", () => {
  const err = thrownBy(() => parseTrakstarList(INACTIVE_ACCOUNT_HTML, company));
  assert.ok(err instanceof Error);
  // The URL has to come from the company row: the notice is Trakstar's own
  // shared page and never names the tenant it replaced.
  assert.match(err.message, /acme\.hire\.trakstar\.com/);
  assert.match(err.message, /tenant does not exist/);
  assert.match(err.message, /inactive-account notice/);
});

test("the cancelled-tenant error is charged to the company, not written off as infrastructure", () => {
  // A cancelled board is a real per-company defect and MUST count toward the
  // row's consecutive_failures. If any of these flipped true the scheduler
  // would retry the board forever and never quarantine it.
  const err = thrownBy(() => parseTrakstarList(INACTIVE_ACCOUNT_HTML, company));
  assert.equal(isTransportError(err), false);
  assert.equal(isEdgeInterstitialError(err), false);
  assert.equal(isInfrastructureFault(err), false);
});

test("parseTrakstarList returns [] for a LIVE tenant whose board has no open roles", () => {
  assert.deepEqual(parseTrakstarList(EMPTY_BOARD_HTML, company), []);
});

test("a page that yielded rows is never failed, even carrying the inactive marker", () => {
  // Belt and braces: the marker cannot coexist with a real board, but the check
  // is gated on an empty parse so a collision could not fail a working tenant.
  const withMarker = INACTIVE_ACCOUNT_HTML.replace("</body>", `${LIST_HTML}</body>`);
  assert.equal(parseTrakstarList(withMarker, company).length, 2);
});

test("trakstarAdapter.listPostings rejects a cancelled tenant and still lists a populated board", async () => {
  globalThis.fetch = () => Promise.resolve(new Response(INACTIVE_ACCOUNT_HTML, { status: 200 }));
  try {
    await assert.rejects(() => trakstarAdapter.listPostings(company), /trakstar: tenant does not exist/);
  } finally {
    restoreFetch();
  }

  const seen = stubPages({ "1": LIST_HTML });
  try {
    const items = await trakstarAdapter.listPostings(company);
    assert.equal(items.length, 2);
    assert.deepEqual(seen, ["1", "2"], "page 2 is the empty page that ends the board");
  } finally {
    restoreFetch();
  }
});

test("parseTrakstarList skips a row whose href doesn't match /jobs/<slug>/ and one with no title", () => {
  const malformed = `
    <div class="js-careers-page-job-list-item">
      <a href="/careers/bad-href/"><h3 class="js-job-list-opening-name">Bad Href</h3></a>
    </div>
    <div class="js-careers-page-job-list-item">
      <a href="/jobs/no-title/"></a>
    </div>`;
  assert.deepEqual(parseTrakstarList(malformed, company), []);
});

test("parseTrakstarJd extracts the JD text from div.jobdesciption (vendor's misspelling)", () => {
  const jd = parseTrakstarJd(JD_HTML);
  assert.match(jd, /Track business numbers/);
  assert.match(jd, /Build dashboards/);
  assert.doesNotMatch(jd, /<div>|<strong>/);
});

test("parseTrakstarJd returns '' when div.jobdesciption is absent (malformed/changed page)", () => {
  assert.equal(parseTrakstarJd("<html><body>Not found</body></html>"), "");
});

// --- listPostings pagination -------------------------------------------------

/** One job row; `n` yields a unique slug so cross-page identity is real. */
function row(n: number): string {
  return `<div class="js-careers-page-job-list-item">
    <a href="/jobs/role-${n}/">
      <h3 class="js-job-list-opening-name">Role ${n}</h3>
      <div class="meta-job-location-city">Bengaluru, India</div>
    </a>
  </div>`;
}

/** A listing page of `count` rows numbered from `start`. */
function page(count: number, start: number): string {
  return `<html><body>${Array.from({ length: count }, (_, i) => row(start + i)).join("")}</body></html>`;
}

const realFetch = globalThis.fetch;
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Serve a canned page per `?p=N` (the bare origin is page 1); anything past
 *  the end is an empty board. Returns the page numbers requested, in order. */
function stubPages(pages: Record<string, string>): string[] {
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const p = url.searchParams.get("p") ?? "1";
    seen.push(p);
    return new Response(pages[p] ?? "<html><body>No jobs right now.</body></html>", { status: 200 });
  };
  return seen;
}

test("trakstarAdapter.listPostings collects the whole board when the tenant pages below the assumed 25", async () => {
  // `?p=N` never tells the server a page size — 25 was a guess about the
  // product, and a tenant serving 5 rows a page had page 1 judged short and
  // the board stopped there.
  const seen = stubPages({ "1": page(5, 1), "2": page(5, 6), "3": page(2, 11) });
  try {
    const items = await trakstarAdapter.listPostings(company);
    assert.equal(items.length, 12, "all three pages, not just the first");
    assert.deepEqual(seen, ["1", "2", "3"], "the 2-row page 3 is short vs the inferred 5 and ends it");
    assert.equal(items[0]?.externalId, "role-1");
    assert.equal(items.at(-1)?.externalId, "role-12");
  } finally {
    restoreFetch();
  }
});

test("trakstarAdapter.listPostings is unchanged on a tenant that really does page at 25", async () => {
  const seen = stubPages({ "1": page(25, 1), "2": page(25, 26), "3": page(7, 51) });
  try {
    const items = await trakstarAdapter.listPostings(company);
    assert.equal(items.length, 57);
    assert.deepEqual(seen, ["1", "2", "3"], "stops on the genuinely short final page");
  } finally {
    restoreFetch();
  }
});

test("trakstarAdapter.listPostings stops on a board that ignores ?p and re-serves page 1", async () => {
  // Trakstar publishes no total, so with every page full the short-page rule
  // never fires either: a board that clamps an out-of-range `p` back to page 1
  // would be crawled all the way to the runaway cap. The exact-page-repeat
  // stall guard is the only thing that can stop it.
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("p") ?? "1");
    if (seen.length > 2) throw new Error("pagination did not detect the repeated page");
    return new Response(page(25, 1), { status: 200 });
  };
  try {
    const items = await trakstarAdapter.listPostings(company);
    assert.equal(items.length, 25, "the repeat contributes nothing new");
    assert.deepEqual(seen, ["1", "2"]);
  } finally {
    restoreFetch();
  }
});

test("trakstarAdapter.listPostings still collapses a slug served on two different pages", async () => {
  // Pages that overlap without being identical are NOT a stall — the board
  // still has more to give, so the crawl continues and only the duplicate row
  // is dropped.
  const seen = stubPages({
    "1": page(5, 1),
    "2": `<html><body>${row(5)}${row(6)}${row(7)}${row(8)}${row(9)}</body></html>`,
    "3": page(2, 10),
  });
  try {
    const items = await trakstarAdapter.listPostings(company);
    assert.deepEqual(seen, ["1", "2", "3"], "an overlapping page must not be treated as the end");
    assert.equal(items.length, 11, "role-5 appears on both pages but only once in the result");
    assert.equal(new Set(items.map((p) => p.externalId)).size, 11);
  } finally {
    restoreFetch();
  }
});
