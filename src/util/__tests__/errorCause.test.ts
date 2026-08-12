import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNotEdgeChallenge,
  challengeEvidence,
  describeError,
  errorCauseCodes,
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
  looksLikeChallengePage,
} from "../errorCause.js";

/** The exact shape undici produces for a DNS failure inside fetch(). */
function undiciDnsFailure(): Error {
  const cause = new Error("getaddrinfo ENOTFOUND nvidia.wd5.myworkdayjobs.com");
  Object.assign(cause, { code: "ENOTFOUND" });
  return new TypeError("fetch failed", { cause });
}

test("describeError keeps the cause that String(err) throws away", () => {
  const err = undiciDnsFailure();
  // The regression this guards: String(err) is the useless 23-char form.
  assert.equal(String(err), "TypeError: fetch failed");
  const described = describeError(err);
  assert.match(described, /TypeError: fetch failed/);
  assert.match(described, /ENOTFOUND/);
  assert.match(described, /nvidia\.wd5\.myworkdayjobs\.com/);
});

test("describeError does not duplicate a code already in the message", () => {
  const described = describeError(undiciDnsFailure());
  assert.equal(described.match(/ENOTFOUND/g)?.length, 1);
});

test("describeError appends a code that the message omits", () => {
  const cause = new Error("read failure");
  Object.assign(cause, { code: "ECONNRESET" });
  assert.match(describeError(new TypeError("fetch failed", { cause })), /\(ECONNRESET\)$/);
});

test("describeError handles a plain error, a non-error and a cycle", () => {
  assert.equal(describeError(new Error("boom")), "Error: boom");
  assert.equal(describeError("just a string"), "just a string");
  const a = new Error("a");
  Object.assign(a, { cause: a }); // self-referential cause must not hang
  assert.equal(describeError(a), "Error: a");
});

test("errorCauseCodes collects codes down the chain", () => {
  assert.deepEqual(errorCauseCodes(undiciDnsFailure()), ["ENOTFOUND"]);
  assert.deepEqual(errorCauseCodes(new Error("no code here")), []);
});

test("isTransportError is true for the run-29 outage signatures", () => {
  assert.ok(isTransportError(undiciDnsFailure()));
  const reset = new Error("socket hang up");
  Object.assign(reset, { code: "ECONNRESET" });
  assert.ok(isTransportError(reset));
  const again = new Error("getaddrinfo EAI_AGAIN host");
  Object.assign(again, { code: "EAI_AGAIN" });
  assert.ok(isTransportError(again));
  // bare TypeError with no cause still reads as transport (message match)
  assert.ok(isTransportError(new TypeError("fetch failed")));
});

test("isTransportError is false for board-shaped failures", () => {
  // These came FROM the board, so they are genuinely per-company and must
  // still count toward quarantine.
  assert.equal(isTransportError(new Error("greenhouse 404")), false);
  assert.equal(isTransportError(new Error("workday HTTP 403: permission denied")), false);
  assert.equal(isTransportError(new Error("gohire HTTP 429: limit exceeded")), false);
  assert.equal(isTransportError(new Error("workday list response failed schema")), false);
  assert.equal(isTransportError(new Error("oracle requires apiMeta.siteNumber")), false);
  assert.equal(isTransportError(new SyntaxError("Unexpected token '<'")), false);
});

/**
 * The real thing: whatever this Node's V8 phrases a JSON.parse failure as, so
 * the classifier is tested against the live message rather than a copy of it.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function jsonParseFailure(body: string): unknown {
  try {
    JSON.parse(body);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${body} to fail JSON.parse`);
}

/** Verbatim from run 31 (2026-08-01), all 17 Workday boards. */
const RUN_31_MESSAGE = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;

test("isEdgeInterstitialError catches the run-31 HTML-for-JSON signature", () => {
  assert.ok(isEdgeInterstitialError(new SyntaxError(RUN_31_MESSAGE)));
  assert.ok(isEdgeInterstitialError(jsonParseFailure("<!DOCTYPE html><html></html>")));
});

test("isEdgeInterstitialError tolerates vendor casing and a bare <html", () => {
  assert.ok(isEdgeInterstitialError(jsonParseFailure('<!doctype html>\n<html lang="en">')));
  assert.ok(isEdgeInterstitialError(jsonParseFailure("<html><body>Access Denied</body></html>")));
});

test("isEdgeInterstitialError sees through an adapter that wraps the parse error", () => {
  const wrapped = new Error("workday list fetch failed", {
    cause: new SyntaxError(RUN_31_MESSAGE),
  });
  assert.ok(isEdgeInterstitialError(wrapped));
});

test("isEdgeInterstitialError is false for failures the board really produced", () => {
  // Malformed but JSON-shaped: the board's application answered, badly.
  assert.equal(isEdgeInterstitialError(jsonParseFailure("xnot json")), false);
  // Truncated body — also the board, so it must keep counting toward quarantine.
  assert.equal(isEdgeInterstitialError(jsonParseFailure('{"jobs":')), false);
  assert.equal(isEdgeInterstitialError(new Error("Unexpected end of JSON input")), false);
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 404")), false);
  assert.equal(
    isEdgeInterstitialError(
      new Error("workday tenant URL missing site segment: https://x.wd5.myworkdayjobs.com"),
    ),
    false,
  );
  // An HTTP status error whose body snippet happens to be HTML is still an HTTP
  // status error — no JSON parse was attempted, so the tag alone proves nothing.
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 520: <!DOCTYPE html>")), false);
});

test("isTransportError is true for an AbortSignal.timeout TimeoutError", () => {
  // AbortSignal.timeout rejects fetch with a DOMException named TimeoutError.
  // A timeout under run congestion says nothing about the board (recruitee /
  // greenhouse / ashby all answered in under 3s when probed individually on
  // 2026-08-12), so it must be retryable and never quarantine-chargeable.
  const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.ok(isTransportError(timedOut));
  assert.ok(isInfrastructureFault(timedOut));
  // Wrapped by an adapter, as the real ones do.
  assert.ok(isTransportError(new Error("recruitee list fetch failed", { cause: timedOut })));
  // A rethrow that kept only the message text still classifies.
  assert.ok(isTransportError(new Error("TimeoutError: The operation was aborted due to timeout")));
});

test("isEdgeInterstitialError treats HTTP 406/429 as the edge throttling, not the board", () => {
  // Avature answers 406 (bare nginx page) to request bursts and 200 to the same
  // request minutes later; eightfold's 429 is an explicit rate limit. Both are
  // the edge refusing the moment, not the board being dead.
  assert.ok(
    isEdgeInterstitialError(
      new Error("avature HTTP 406: <html>\r\n<head><title>406 Not Acceptable</title></head>"),
    ),
  );
  assert.ok(isEdgeInterstitialError(new Error("eightfoldpcs HTTP 429: Please try again later")));
  // Still not transport-shaped — the predicates stay disjoint.
  assert.equal(isTransportError(new Error("eightfoldpcs HTTP 429: Please try again later")), false);
  // Neighbouring statuses stay board defects.
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 422: {\"errorCode\":\"x\"}")), false);
  assert.equal(isEdgeInterstitialError(new Error("onecard HTTP 500: upstream broke")), false);
});

test("the two infrastructure predicates stay disjoint", () => {
  // A DNS death is transport-shaped, and must not be what the new predicate catches.
  assert.equal(isEdgeInterstitialError(undiciDnsFailure()), false);
  assert.ok(isTransportError(undiciDnsFailure()));
  // An interstitial arrives over a healthy socket (HTTP 200), so it is not transport.
  assert.equal(isTransportError(jsonParseFailure("<!DOCTYPE html>")), false);
});

/**
 * The union of the two is what every caller actually wants to route on, so it
 * lives here rather than being re-derived per call site. The JD-fetch loop in
 * pipeline/postingPipeline.ts checked only isTransportError until it used this,
 * which is why an edge page there dropped the posting with zero retries.
 */
test("isInfrastructureFault covers both shapes the board is not to blame for", () => {
  assert.ok(isInfrastructureFault(undiciDnsFailure()));
  assert.ok(isInfrastructureFault(new SyntaxError(RUN_31_MESSAGE)));
  assert.ok(isInfrastructureFault(jsonParseFailure("<!DOCTYPE html><html></html>")));
  // Wrapped by an adapter, as the real ones do.
  assert.ok(
    isInfrastructureFault(
      new Error("workday list fetch failed", { cause: new SyntaxError(RUN_31_MESSAGE) }),
    ),
  );
});

test("isInfrastructureFault is false for board defects, which must still count", () => {
  assert.equal(isInfrastructureFault(new Error("greenhouse 404")), false);
  assert.equal(isInfrastructureFault(new Error("workday HTTP 403: permission denied")), false);
  assert.equal(isInfrastructureFault(new Error("oracle requires apiMeta.siteNumber")), false);
  // Malformed but JSON-shaped, and truncated: the board's application answered.
  assert.equal(isInfrastructureFault(jsonParseFailure("xnot json")), false);
  assert.equal(isInfrastructureFault(jsonParseFailure('{"jobs":')), false);
});

// --- HTML bot-block / challenge pages ----------------------------------------
//
// The JSON-parse rule above cannot see these: an HTML adapter never parses JSON,
// so a WAF page reaches its dead-tenant guard as ordinary markup with no job rows
// and no engine fingerprint — the exact shape the guard is built to fail. Twelve
// radancy rows (AstraZeneca 4,681 postings, Amgen 2,014, Optum 1,719, ...) sit
// behind such an edge, so five refusals in a row would have quarantined them.

/** Bodies shaped like the block pages this repo's boards actually sit behind,
 *  trimmed to the marker plus enough chrome to stay recognisable. */
const INCAPSULA_BODY =
  `<html><head><title>Request unsuccessful. Incapsula incident ID: ` +
  `489000670129277600-30177459283132412</title></head><body></body></html>`;
const CLOUDFLARE_IUAM_BODY =
  `<!DOCTYPE html><html class="no-js"><head><title>Just a moment...</title>` +
  `<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head>` +
  `<body class="cf-browser-verification"><h1>Checking your browser before accessing ` +
  `careers.arm.com</h1></body></html>`;
const CLOUDFLARE_BLOCK_BODY =
  `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>` +
  `<body><h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: 8f2a1c</p></body></html>`;
const CLOUDFLARE_TURNSTILE_BODY =
  `<!DOCTYPE html><html><body><h2>Verifying you are human. This may take a few seconds.</h2>` +
  `<noscript>Please enable JS and disable any ad blocker</noscript></body></html>`;
const AKAMAI_BODY =
  `<!DOCTYPE html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>` +
  `<p>You don't have permission to access "http://careers.amgen.com/search-jobs" on this ` +
  `server.<p>Reference #18.5d1d1002.1754179200.1a2b3c4d</body></html>`;
const AWS_WAF_BODY =
  `<!DOCTYPE html><html><head><script src="https://de0c4f5c.token.awswaf.com/de0c4f5c/` +
  `challenge.js"></script></head><body><div id="challenge-container"></div></body></html>`;

const CHALLENGE_BODIES: Array<[string, string]> = [
  ["incapsula", INCAPSULA_BODY],
  ["cloudflare interstitial", CLOUDFLARE_IUAM_BODY],
  ["cloudflare block", CLOUDFLARE_BLOCK_BODY],
  ["cloudflare turnstile", CLOUDFLARE_TURNSTILE_BODY],
  ["akamai", AKAMAI_BODY],
  ["aws waf", AWS_WAF_BODY],
];

test("looksLikeChallengePage recognises every block page the boards sit behind", () => {
  for (const [vendor, body] of CHALLENGE_BODIES) {
    assert.ok(looksLikeChallengePage(body), `${vendor} body must read as a challenge page`);
  }
});

/**
 * Pages that must NOT read as a challenge — a marker that fires here would turn a
 * genuine board defect (or a healthy empty board) into an un-chargeable fault, and
 * a board that is really gone would then never quarantine.
 */
test("looksLikeChallengePage stays quiet on ordinary careers markup", () => {
  // A live Radancy search page with nothing matching today (Cargill, probed 2026-08-03).
  assert.equal(
    looksLikeChallengePage(
      `<section id="search-results" data-total-pages="0" data-total-results="0"></section>`,
    ),
    false,
  );
  // "Reference #" is how boards label requisition ids, so it can never fire alone.
  assert.equal(
    looksLikeChallengePage(`<li class="job"><span>Reference #18274</span>Data Engineer</li>`),
    false,
  );
  // Employers really do run coding challenges, and "challenge-container" is an
  // ordinary CSS class name.
  assert.equal(
    looksLikeChallengePage(`<div class="challenge-container">Take our coding challenge</div>`),
    false,
  );
  // An SPA shell's own noscript / loading copy is not a bot block.
  assert.equal(
    looksLikeChallengePage(`<noscript>Please enable JavaScript to view this site</noscript>`),
    false,
  );
  assert.equal(looksLikeChallengePage(`<div class="spinner">Just a moment...</div>`), false);
  // A bare 403 body, and an application-form validation string.
  assert.equal(looksLikeChallengePage(`{"error":"Access Denied"}`), false);
  assert.equal(looksLikeChallengePage(`<p>Request unsuccessful, please try again.</p>`), false);
  assert.equal(looksLikeChallengePage(""), false);
});

test("challengeEvidence quotes every marker it matched, so the quote re-classifies", () => {
  const evidence = challengeEvidence(AKAMAI_BODY);
  assert.ok(evidence !== null);
  // Both halves of a paired marker have to survive into the quote, or an error
  // built from it would no longer satisfy the pair when re-scanned.
  assert.match(evidence, /Access Denied/i);
  assert.match(evidence, /permission to access/i);
  // Quoting the evidence is itself the bounded snippet — no document travels with
  // the error into last_error or the Discord summary.
  assert.ok(evidence.length <= 200, `evidence must stay short, got ${evidence.length}`);
  assert.equal(challengeEvidence(`<section data-total-results="0"></section>`), null);
});

test("isEdgeInterstitialError catches a challenge page carried in the error text", () => {
  for (const [vendor, body] of CHALLENGE_BODIES) {
    const err = new Error(`radancy: edge refused https://careers.x.com — body: ${body}`);
    assert.ok(isEdgeInterstitialError(err), `${vendor} must classify as an edge interstitial`);
    assert.ok(isInfrastructureFault(err), `${vendor} must be an infrastructure fault`);
  }
});

test("an HTTP status error whose body is a challenge page is the edge, not the board", () => {
  // atsHttpError embeds a 200-char body snippet, so this arrives for free: a 403
  // carrying Cloudflare's block page is an edge refusing us, not a broken board.
  assert.ok(
    isInfrastructureFault(
      new Error(`radancy HTTP 403: ${CLOUDFLARE_BLOCK_BODY.slice(0, 200)}`),
    ),
  );
});

test("assertNotEdgeChallenge throws an infrastructure-shaped error, or nothing", () => {
  for (const [vendor, body] of CHALLENGE_BODIES) {
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    let thrown: unknown;
    try {
      assertNotEdgeChallenge("radancy", "https://careers.amgen.com/search-jobs", body);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, `${vendor} must be rejected`);
    // The round trip is the whole mechanism: whatever the guard throws has to be
    // classifiable by the predicate the scheduler routes on.
    assert.ok(isInfrastructureFault(thrown), `${vendor} error must classify as infrastructure`);
    assert.match(thrown.message, /careers\.amgen\.com/);
    // A page must never travel with the error — last_error goes to the DB and Discord.
    assert.ok(thrown.message.length <= 400, `message must stay bounded, got ${thrown.message.length}`);
    assert.ok(!thrown.message.includes("<!DOCTYPE"), "no raw document in the stored error");
  }
});

test("assertNotEdgeChallenge lets ordinary markup through untouched", () => {
  assert.doesNotThrow(() =>
    assertNotEdgeChallenge(
      "radancy",
      "https://careers.cargill.com/en/search-jobs/India",
      `<section id="search-results" data-total-results="0"></section>`,
    ),
  );
});

/**
 * The amnesty must stay narrow. A board that is genuinely gone still has to reach
 * consecutive_failures, so the dead-tenant guards' own wording — which describes a
 * block page without being one — must stay chargeable.
 */
test("a dead-board verdict with no challenge markers is still a board defect", () => {
  assert.equal(
    isInfrastructureFault(
      new Error(
        `radancy: board no longer served — https://careers.ford.com/search-jobs returned a page ` +
          `with no job cards AND no data-total-results pager state, so it is not a Radancy ` +
          `search-results page and the board is dead rather than empty.`,
      ),
    ),
    false,
  );
  assert.equal(
    isInfrastructureFault(
      new Error(
        `successfactors: tenant does not exist at https://careers.x.com/search/ — the response ` +
          `carries none of the Jobs2Web engine's assets (parked, re-pointed, or a 200-served ` +
          `block page).`,
      ),
    ),
    false,
  );
  assert.equal(
    isInfrastructureFault(new Error("freshteam: tenant does not exist — claim it now page")),
    false,
  );
  assert.equal(isInfrastructureFault(new Error("jazzhr 404")), false);
  assert.equal(
    isInfrastructureFault(new Error("radancy list response failed schema for ford")),
    false,
  );
});
