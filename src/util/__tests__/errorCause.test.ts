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
import type { Caught } from "../errorCause.js";
import { thrownBy } from "../../__tests__/caught.js";

/** The shape undici produces for a DNS failure inside fetch(). */
function undiciDnsFailure(): Error {
  const cause = new Error("getaddrinfo ENOTFOUND nvidia.wd5.myworkdayjobs.com");
  Object.assign(cause, { code: "ENOTFOUND" });
  return new TypeError("fetch failed", { cause });
}

test("describeError keeps the cause that String(err) throws away", () => {
  const err = undiciDnsFailure();
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
  Object.assign(a, { cause: a });
  assert.equal(describeError(a), "Error: a");
});

test("errorCauseCodes collects codes down the chain", () => {
  assert.deepEqual(errorCauseCodes(undiciDnsFailure()), ["ENOTFOUND"]);
  assert.deepEqual(errorCauseCodes(new Error("no code here")), []);
});

test("isTransportError is true for common outage signatures", () => {
  assert.ok(isTransportError(undiciDnsFailure()));
  const reset = new Error("socket hang up");
  Object.assign(reset, { code: "ECONNRESET" });
  assert.ok(isTransportError(reset));
  const again = new Error("getaddrinfo EAI_AGAIN host");
  Object.assign(again, { code: "EAI_AGAIN" });
  assert.ok(isTransportError(again));
  assert.ok(isTransportError(new TypeError("fetch failed")));
});

test("isTransportError is false for board-shaped failures", () => {
  assert.equal(isTransportError(new Error("greenhouse 404")), false);
  assert.equal(isTransportError(new Error("workday HTTP 403: permission denied")), false);
  assert.equal(isTransportError(new Error("gohire HTTP 429: limit exceeded")), false);
  assert.equal(isTransportError(new Error("workday list response failed schema")), false);
  assert.equal(isTransportError(new Error("oracle requires apiMeta.siteNumber")), false);
  assert.equal(isTransportError(new SyntaxError("Unexpected token '<'")), false);
});

function jsonParseFailure(body: string): Caught {
  return thrownBy(() => {
    JSON.parse(body);
  });
}

const RUN_31_MESSAGE = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;

test("isEdgeInterstitialError catches the HTML-for-JSON signature", () => {
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
  assert.equal(isEdgeInterstitialError(jsonParseFailure("xnot json")), false);
  assert.equal(isEdgeInterstitialError(jsonParseFailure('{"jobs":')), false);
  assert.equal(isEdgeInterstitialError(new Error("Unexpected end of JSON input")), false);
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 404")), false);
  assert.equal(
    isEdgeInterstitialError(
      new Error("workday tenant URL missing site segment: https://x.wd5.myworkdayjobs.com"),
    ),
    false,
  );
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 520: <!DOCTYPE html>")), false);
});

test("isTransportError is true for an AbortSignal.timeout TimeoutError", () => {
  const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.ok(isTransportError(timedOut));
  assert.ok(isInfrastructureFault(timedOut));
  assert.ok(isTransportError(new Error("recruitee list fetch failed", { cause: timedOut })));
  assert.ok(isTransportError(new Error("TimeoutError: The operation was aborted due to timeout")));
});

test("isEdgeInterstitialError treats HTTP 406/429 as the edge throttling, not the board", () => {
  assert.ok(
    isEdgeInterstitialError(
      new Error("avature HTTP 406: <html>\r\n<head><title>406 Not Acceptable</title></head>"),
    ),
  );
  assert.ok(isEdgeInterstitialError(new Error("eightfoldpcs HTTP 429: Please try again later")));
  assert.equal(isTransportError(new Error("eightfoldpcs HTTP 429: Please try again later")), false);
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 422: {\"errorCode\":\"x\"}")), false);
  assert.equal(isEdgeInterstitialError(new Error("onecard HTTP 500: upstream broke")), false);
});

test("the two infrastructure predicates stay disjoint", () => {
  assert.equal(isEdgeInterstitialError(undiciDnsFailure()), false);
  assert.ok(isTransportError(undiciDnsFailure()));
  assert.equal(isTransportError(jsonParseFailure("<!DOCTYPE html>")), false);
});

test("isInfrastructureFault covers both shapes the board is not to blame for", () => {
  assert.ok(isInfrastructureFault(undiciDnsFailure()));
  assert.ok(isInfrastructureFault(new SyntaxError(RUN_31_MESSAGE)));
  assert.ok(isInfrastructureFault(jsonParseFailure("<!DOCTYPE html><html></html>")));
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
  assert.equal(isInfrastructureFault(jsonParseFailure("xnot json")), false);
  assert.equal(isInfrastructureFault(jsonParseFailure('{"jobs":')), false);
});

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
// CloudFront edge 403 page; the stored 200-char snippet truncates at `<TITLE>ERROR`.
const CLOUDFRONT_BODY =
  `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">\n` +
  `<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1">\n` +
  `<TITLE>ERROR: The request could not be satisfied</TITLE>\n</HEAD><BODY>\n<H1>403 ERROR</H1>\n` +
  `<H2>The request could not be satisfied.</H2>\n<HR noshade size="1px">\nRequest blocked. ` +
  `We can't connect to the server for this app or website at this time.\n<BR clear="all">\n` +
  `<PRE>\nGenerated by cloudfront (CloudFront)\nRequest ID: 8skGKzMvyeMU_XeIvvY0Yl9Rt5vGKKzcDcCLbHzGpbY==\n</PRE>\n</BODY></HTML>`;

const CHALLENGE_BODIES: Array<[string, string]> = [
  ["incapsula", INCAPSULA_BODY],
  ["cloudflare interstitial", CLOUDFLARE_IUAM_BODY],
  ["cloudflare block", CLOUDFLARE_BLOCK_BODY],
  ["cloudflare turnstile", CLOUDFLARE_TURNSTILE_BODY],
  ["akamai", AKAMAI_BODY],
  ["aws waf", AWS_WAF_BODY],
  ["cloudfront", CLOUDFRONT_BODY],
];

test("looksLikeChallengePage recognises every block page the boards sit behind", () => {
  for (const [vendor, body] of CHALLENGE_BODIES) {
    assert.ok(looksLikeChallengePage(body), `${vendor} body must read as a challenge page`);
  }
});

test("looksLikeChallengePage stays quiet on ordinary careers markup", () => {
  assert.equal(
    looksLikeChallengePage(
      `<section id="search-results" data-total-pages="0" data-total-results="0"></section>`,
    ),
    false,
  );
  assert.equal(
    looksLikeChallengePage(`<li class="job"><span>Reference #18274</span>Data Engineer</li>`),
    false,
  );
  assert.equal(
    looksLikeChallengePage(`<div class="challenge-container">Take our coding challenge</div>`),
    false,
  );
  assert.equal(
    looksLikeChallengePage(`<noscript>Please enable JavaScript to view this site</noscript>`),
    false,
  );
  assert.equal(looksLikeChallengePage(`<div class="spinner">Just a moment...</div>`), false);
  assert.equal(looksLikeChallengePage(`{"error":"Access Denied"}`), false);
  assert.equal(looksLikeChallengePage(`<p>Request unsuccessful, please try again.</p>`), false);
  assert.equal(
    looksLikeChallengePage(
      `<html><head><script src="https://d1a2b3c4.cloudfront.net/bundle.js"></script></head>` +
        `<body><li class="job">Data Engineer</li></body></html>`,
    ),
    false,
  );
  assert.equal(looksLikeChallengePage(""), false);
});

test("challengeEvidence quotes every marker it matched, so the quote re-classifies", () => {
  const evidence = challengeEvidence(AKAMAI_BODY);
  assert.ok(evidence !== null);
  assert.match(evidence, /Access Denied/i);
  assert.match(evidence, /permission to access/i);
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
  assert.ok(
    isInfrastructureFault(
      new Error(`radancy HTTP 403: ${CLOUDFLARE_BLOCK_BODY.slice(0, 200)}`),
    ),
  );
});

test("assertNotEdgeChallenge throws an infrastructure-shaped error, or nothing", () => {
  for (const [vendor, body] of CHALLENGE_BODIES) {
    const thrown = thrownBy(() => assertNotEdgeChallenge("radancy", "https://careers.amgen.com/search-jobs", body));
    assert.ok(thrown instanceof Error, `${vendor} must be rejected`);
    assert.ok(isInfrastructureFault(thrown), `${vendor} error must classify as infrastructure`);
    assert.match(thrown.message, /careers\.amgen\.com/);
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

test("isTransportError is false for a TLS certificate the host itself serves wrong", () => {
  for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const cause = new Error(`cert problem ${code}`);
    Object.assign(cause, { code });
    assert.equal(isTransportError(new TypeError("fetch failed", { cause })), false, code);
  }
});
