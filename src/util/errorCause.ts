/**
 * Undici's `fetch` reports every connection-level failure as the same opaque
 * `TypeError: fetch failed` and hides the real error in `err.cause`. Since
 * `String(err)` drops the cause, a stored error told us nothing: run 29
 * (2026-07-26) recorded 72 dead Workday boards as 23 characters of
 * "TypeError: fetch failed", which is indistinguishable from a genuinely broken
 * board. These helpers walk the cause chain so the stored text names the actual
 * failure (ENOTFOUND, ECONNRESET, ...) and so the scheduler can tell a transport
 * fault apart from a board defect.
 */

/** Cause chains are shallow in practice; the cap only guards a cyclic `cause`. */
const MAX_CAUSE_DEPTH = 5;

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- narrows a caught value, so `unknown` is the input type by construction
function hasStringCode(value: unknown): value is { code: string } {
  if (typeof value !== "object" || value === null) return false;
  // `in` narrows the property to unknown, so no assertion is needed to read it.
  if (!("code" in value)) return false;
  return typeof value.code === "string";
}

/** Walk `err` and its `cause` chain, outermost first. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function chain(err: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  const out: unknown[] = [];
  let current = err;
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && out.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    out.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return out;
}

/**
 * Every `code` in the cause chain (e.g. ["ENOTFOUND"]). Empty when the failure
 * carries no syscall/undici code — i.e. it is not transport-shaped.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function errorCauseCodes(err: unknown): string[] {
  return chain(err)
    .filter(hasStringCode)
    .map((e) => e.code);
}

/**
 * Human-readable error text that keeps the cause. `TypeError: fetch failed`
 * becomes `TypeError: fetch failed <- Error: getaddrinfo ENOTFOUND host (ENOTFOUND)`,
 * which is the difference between diagnosing an outage and guessing at one.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function describeError(err: unknown): string {
  const parts = chain(err).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  const codes = errorCauseCodes(err);
  const text = parts.length > 0 ? parts.join(" <- ") : String(err);
  // Codes usually appear in the message already; append only what is missing so
  // the tag stays greppable without duplicating text.
  const missing = codes.filter((c) => !text.includes(c));
  return missing.length > 0 ? `${text} (${missing.join(",")})` : text;
}

/**
 * Transport-shaped failures: the network/DNS/socket layer never delivered a
 * response, so the remote board told us nothing about itself. These are
 * retryable and must NOT count toward a company's consecutive-failure
 * quarantine — a dead resolver is not a dead board.
 *
 * Deliberately excluded: HTTP status errors (4xx/5xx), schema failures and
 * config errors. Those came FROM the board and are genuinely per-company.
 */
const TRANSPORT_CODES = new Set([
  "ENOTFOUND", // DNS: no such host
  "EAI_AGAIN", // DNS: temporary resolver failure
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ETIMEDOUT",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** Matches transport failures that surface as a message rather than a code. */
const TRANSPORT_MESSAGE_RE =
  /fetch failed|socket hang up|network socket disconnected|other side closed|terminated|client network socket/i;

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isTransportError(err: unknown): boolean {
  if (errorCauseCodes(err).some((c) => TRANSPORT_CODES.has(c))) return true;
  return TRANSPORT_MESSAGE_RE.test(describeError(err));
}

/** V8's JSON.parse failure text. Matched as well as the SyntaxError type so a
 *  rethrow that keeps only the message still classifies. */
const JSON_PARSE_MESSAGE_RE = /is not valid JSON|Unexpected end of JSON input/i;

/** The body's first non-space character opened a tag, i.e. it was a document.
 *  `Unexpected token '<'` is V8's own way of saying so when it truncates. */
const MARKUP_BODY_RE = /Unexpected token '<'|<!doctype\b|<html\b/i;

/**
 * Markers that on their own prove the response came from a bot-blocker rather than
 * from the board. Every one is either a vendor brand token or a sentence a careers
 * page has no reason to contain, because a false positive here is worse than the
 * bug being fixed: it would hand a genuinely dead board a permanent excuse.
 *
 * Deliberately rejected as too weak to stand alone, with the pairing used instead
 * in CHALLENGE_PAIRED_MARKERS below:
 *   "Reference #"        — how boards label requisition ids ("Reference #18274").
 *   "challenge-container" — employers run coding challenges; it is a CSS class name.
 *   "Access Denied"      — also a plain 403 body and an app-level error string.
 *   "Just a moment..."   — ordinary loading copy in an un-hydrated SPA shell.
 *   "Attention Required!" — plain English a page can use for its own warnings, and
 *                           one word off the "Attention!" chrome SuccessFactors
 *                           renders on a healthy tenant with nothing open.
 *   "Request unsuccessful" / "Incident ID:" — generic enough to be app-level text.
 */
const CHALLENGE_STRONG_MARKERS = [
  /Incapsula incident ID/i, // Imperva/Incapsula block page
  /cf-browser-verification/i, // Cloudflare interstitial body class
  /\/cdn-cgi\/challenge-platform/i, // Cloudflare challenge asset path
  /Checking your browser before accessing/i, // Cloudflare interstitial heading
  /Sorry, you have been blocked/i, // Cloudflare 1020, the datacenter-IP block
  /Verifying you are human/i, // Cloudflare Turnstile managed challenge
  /Please enable JS and disable any ad blocker/i, // Cloudflare's noscript line
  /\bawswaf\b/i, // token.awswaf.com / AWS WAF challenge+captcha JS namespace
];

/**
 * Phrases that only count as a block page alongside a second, corroborating
 * signal — the pairing is what keeps them off legitimate careers markup.
 */
const CHALLENGE_PAIRED_MARKERS: Array<readonly [RegExp, RegExp]> = [
  [/Attention Required!/i, /cloudflare/i],
  [/Access Denied/i, /you (?:don['’]?t|do not) have permission to access/i],
  [/Reference\s*#/i, /Access Denied|you (?:don['’]?t|do not) have permission|akamai/i],
  [/Just a moment\.\.\./i, /cloudflare|cdn-cgi|cf-chl|ray id/i],
  [/Incident ID\s*:/i, /Request unsuccessful|Incapsula|Access Denied/i],
  [/Request unsuccessful/i, /incident id|support id/i],
  [/AWS WAF/i, /request blocked|challenge|captcha/i],
];

/** Longest excerpt of one marker match kept as evidence. Every marker above is a
 *  short fixed phrase, so this only guards a pathological regex. */
const MARKER_EXCERPT_MAX = 80;

function quoteMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  const hit = m?.[0];
  return hit === undefined ? null : `"${hit.slice(0, MARKER_EXCERPT_MAX)}"`;
}

/**
 * The marker text this body matched, quoted — or null when nothing did.
 *
 * The quote IS the sanitised snippet: every piece of it is a literal substring of
 * the body, short and bounded, so an error built from it can travel into
 * `last_error` (the DB and the Discord summary) without carrying a document. Both
 * halves of a paired marker are quoted on purpose, so re-scanning the quote
 * satisfies the same pairing rule the body did — that round trip is what lets a
 * guard throw an error the classifier will still recognise.
 */
export function challengeEvidence(text: string): string | null {
  for (const re of CHALLENGE_STRONG_MARKERS) {
    const quoted = quoteMatch(re, text);
    if (quoted !== null) return quoted;
  }
  for (const [primary, corroborating] of CHALLENGE_PAIRED_MARKERS) {
    const first = quoteMatch(primary, text);
    if (first === null) continue;
    const second = quoteMatch(corroborating, text);
    if (second !== null) return `${first} + ${second}`;
  }
  return null;
}

/**
 * Whether a response body is a bot-block / WAF challenge page rather than the
 * board. The HTML dead-tenant guards ask this BEFORE reaching their verdict: an
 * absence-of-fingerprint guard cannot otherwise tell a blocked request from a host
 * that stopped serving the board, because a challenge page has no job rows and none
 * of the vendor's engine markup either.
 */
export function looksLikeChallengePage(html: string): boolean {
  return challengeEvidence(html) !== null;
}

/**
 * Throw an infrastructure-shaped error if `body` is a bot-block page. Guards call
 * this first, so an edge refusal never reaches a dead-board verdict.
 *
 * The message quotes the matched marker, which is what makes the thrown error
 * classify as infrastructure again on the way out (see challengeEvidence). One
 * marker set therefore decides both halves — a guard can never disagree with the
 * scheduler about what a challenge looks like.
 */
export function assertNotEdgeChallenge(provider: string, url: string, body: string): void {
  const evidence = challengeEvidence(body);
  if (evidence === null) return;

  throw new Error(
    `${provider}: an edge refused the request — ${url} answered with a bot-block/challenge page ` +
      `(matched ${evidence}) instead of the board, so the response says nothing about whether ` +
      `the board is alive.`,
  );
}

/**
 * A JSON endpoint that answers with an HTML document is not a broken board: it is
 * an edge interstitial (WAF challenge, rate-limit notice, error page) in front of a
 * healthy board. Run 31 (2026-08-01) lost 17 Workday boards this way inside a
 * 24-second window — alphabetically consecutive tenants, and every one returned
 * HTTP 200 application/json when probed individually minutes later. Because the
 * body arrives over a live socket with a 2xx status, isTransportError cannot see it,
 * so the scheduler was charging the burst to each board's quarantine counter.
 *
 * Matching is deliberately narrow: only a JSON parse failure whose body began with
 * a tag. Malformed-but-JSON bodies and truncated bodies stay board defects, and an
 * HTTP status error carrying an HTML snippet stays an HTTP status error — those
 * really did come from the board's application.
 *
 * The parse rule alone left the HTML adapters exposed, because they never parse
 * JSON: a challenge page reaches their dead-tenant guard as markup with no job rows
 * and no engine fingerprint, which is exactly what a dead host looks like. So an
 * explicit bot-block signature anywhere in the error text also counts — that covers
 * the guards (which quote the marker they matched) and, for free, an HTTP status
 * error whose 200-char body snippet from atsHttpError is a block page. A 403 served
 * by Cloudflare's block page is an edge refusing us, not a board defect.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isEdgeInterstitialError(err: unknown): boolean {
  const text = describeError(err);
  if (looksLikeChallengePage(text)) return true;
  const parseFailed =
    chain(err).some((e) => e instanceof SyntaxError) || JSON_PARSE_MESSAGE_RE.test(text);
  return parseFailed && MARKUP_BODY_RE.test(text);
}

/**
 * Faults from the network or from an edge in front of the board — never from the
 * board's own application. Retryable, and never chargeable to the company's
 * failure count.
 *
 * The union lives here so every caller routes on the same rule: while the OR was
 * copied into the scheduler alone, the JD-fetch loop in pipeline/postingPipeline.ts
 * still tested transport only, giving an edge page zero retries and silently
 * dropping the posting before it was ever inserted.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isInfrastructureFault(err: unknown): boolean {
  return isTransportError(err) || isEdgeInterstitialError(err);
}
