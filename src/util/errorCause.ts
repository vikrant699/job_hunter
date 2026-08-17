// Undici's fetch collapses every connection-level failure into the same opaque "TypeError: fetch failed" and hides the real
// error in err.cause, which String(err) drops. These helpers walk the cause chain so the stored text names the actual
// failure (ENOTFOUND, ECONNRESET, ...) and the scheduler can tell a transport fault apart from a board defect.

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

/** Every `code` in the cause chain; empty when the failure carries no syscall/undici code (not transport-shaped). */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function errorCauseCodes(err: unknown): string[] {
  return chain(err)
    .filter(hasStringCode)
    .map((e) => e.code);
}

/** Human-readable error text that keeps the cause chain, e.g. "TypeError: fetch failed <- Error: getaddrinfo ENOTFOUND host". */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function describeError(err: unknown): string {
  const parts = chain(err).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
  const codes = errorCauseCodes(err);
  const text = parts.length > 0 ? parts.join(" <- ") : String(err);
  // Append only codes missing from the message, so the tag stays greppable without duplicating text.
  const missing = codes.filter((c) => !text.includes(c));
  return missing.length > 0 ? `${text} (${missing.join(",")})` : text;
}

/** Transport-shaped failures (network/DNS/socket never delivered a response) are retryable and must not count toward a
 *  company's failure quarantine - a dead resolver is not a dead board. HTTP status/schema/config errors are excluded; those came from the board. */
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
  /fetch failed|socket hang up|network socket disconnected|other side closed|terminated|client network socket|aborted due to timeout/i;

/** AbortSignal.timeout rejects with a DOMException whose name is "TimeoutError"
 *  (it is not always an Error subclass, so match the name, not instanceof). */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- narrows a caught value, so `unknown` is the input type by construction
function hasTimeoutName(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value)) return false;
  return value.name === "TimeoutError";
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isTransportError(err: unknown): boolean {
  if (errorCauseCodes(err).some((c) => TRANSPORT_CODES.has(c))) return true;
  // A per-call timeout dies on our side of the wire (a large response can outlast the budget under run congestion while the
  // board itself is healthy); no response was read, so it says nothing about the board.
  if (chain(err).some(hasTimeoutName)) return true;
  return TRANSPORT_MESSAGE_RE.test(describeError(err));
}

/** V8's JSON.parse failure text. Matched as well as the SyntaxError type so a
 *  rethrow that keeps only the message still classifies. */
const JSON_PARSE_MESSAGE_RE = /is not valid JSON|Unexpected end of JSON input/i;

/** The body's first non-space character opened a tag, i.e. it was a document.
 *  `Unexpected token '<'` is V8's own way of saying so when it truncates. */
const MARKUP_BODY_RE = /Unexpected token '<'|<!doctype\b|<html\b/i;

// Markers that on their own prove a bot-blocker response, not the board: each is a vendor brand token or a sentence a
// careers page has no reason to contain, since a false positive here would hand a genuinely dead board a permanent excuse.
// Weaker phrases (generic enough to appear in legitimate app text) are pairing-gated instead, in CHALLENGE_PAIRED_MARKERS.
const CHALLENGE_STRONG_MARKERS = [
  /Incapsula incident ID/i, // Imperva/Incapsula block page
  /cf-browser-verification/i, // Cloudflare interstitial body class
  /\/cdn-cgi\/challenge-platform/i, // Cloudflare challenge asset path
  /Checking your browser before accessing/i, // Cloudflare interstitial heading
  /Sorry, you have been blocked/i, // Cloudflare 1020, the datacenter-IP block
  /Verifying you are human/i, // Cloudflare Turnstile managed challenge
  /Please enable JS and disable any ad blocker/i, // Cloudflare's noscript line
  /\bawswaf\b/i, // token.awswaf.com / AWS WAF challenge+captcha JS namespace
  /Generated by cloudfront/i, // CloudFront's own error/block page footer
];

/** Phrases that only count as a block page alongside a second, corroborating signal, keeping them off legitimate careers markup. */
const CHALLENGE_PAIRED_MARKERS: Array<readonly [RegExp, RegExp]> = [
  [/Attention Required!/i, /cloudflare/i],
  [/Access Denied/i, /you (?:don['’]?t|do not) have permission to access/i],
  [/Reference\s*#/i, /Access Denied|you (?:don['’]?t|do not) have permission|akamai/i],
  [/Just a moment\.\.\./i, /cloudflare|cdn-cgi|cf-chl|ray id/i],
  [/Incident ID\s*:/i, /Request unsuccessful|Incapsula|Access Denied/i],
  [/Request unsuccessful/i, /incident id|support id/i],
  [/AWS WAF/i, /request blocked|challenge|captcha/i],
  // CloudFront's block-page headline, paired with the brand token since careers pages routinely serve assets from *.cloudfront.net.
  [/The request could not be satisfied/i, /cloudfront/i],
];

/** Longest excerpt of one marker match kept as evidence. Every marker above is a
 *  short fixed phrase, so this only guards a pathological regex. */
const MARKER_EXCERPT_MAX = 80;

function quoteMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  const hit = m?.[0];
  return hit === undefined ? null : `"${hit.slice(0, MARKER_EXCERPT_MAX)}"`;
}

/** The marker text this body matched, quoted (or null). The quote is a short bounded literal substring so it can travel
 *  into `last_error` without carrying a whole document, and re-scanning it still satisfies the same pairing rule. */
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

/** Whether a body is a bot-block/WAF challenge page rather than the board; HTML dead-tenant guards check this first, since a
 *  challenge page has no job rows or engine markup either, indistinguishable otherwise from a genuinely dead host. */
export function looksLikeChallengePage(html: string): boolean {
  return challengeEvidence(html) !== null;
}

/** Throws an infrastructure-shaped error if `body` is a bot-block page, so an edge refusal never reaches a dead-board verdict.
 *  Quotes the matched marker so the thrown error re-classifies as infrastructure on the way out. */
export function assertNotEdgeChallenge(provider: string, url: string, body: string): void {
  const evidence = challengeEvidence(body);
  if (evidence === null) return;

  throw new Error(
    `${provider}: an edge refused the request — ${url} answered with a bot-block/challenge page ` +
      `(matched ${evidence}) instead of the board, so the response says nothing about whether ` +
      `the board is alive.`,
  );
}

// A JSON endpoint answering with an HTML document is an edge interstitial (WAF challenge, rate-limit notice) in front of a
// healthy board, not a broken one - since it arrives over a live socket with a 2xx status, isTransportError can't see it.
// Matching is narrow: only a JSON parse failure whose body began with a tag (malformed-but-JSON and truncated bodies stay
// board defects). An explicit bot-block signature anywhere in the text also counts, covering HTML adapters that never
// parse JSON and would otherwise see a challenge page as indistinguishable from a dead host.

/** HTTP statuses that are an edge refusing the moment, not the board refusing the request (429 rate limit; 406 is how some
 *  nginx/AppTrana edges answer traffic that looks automated, with the same request succeeding minutes later). Narrow on
 *  purpose - 403/422/5xx stay board defects since those regularly are the board's own application answering. */
const EDGE_REFUSAL_STATUS_RE = /\bHTTP (?:406|429)\b/;

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isEdgeInterstitialError(err: unknown): boolean {
  const text = describeError(err);
  if (looksLikeChallengePage(text)) return true;
  if (EDGE_REFUSAL_STATUS_RE.test(text)) return true;
  const parseFailed =
    chain(err).some((e) => e instanceof SyntaxError) || JSON_PARSE_MESSAGE_RE.test(text);
  return parseFailed && MARKUP_BODY_RE.test(text);
}

/** Faults from the network or an edge in front of the board, never from the board's own application: retryable and never
 *  chargeable to the company's failure count. Lives here so every caller (scheduler, JD-fetch loop) routes on the same rule. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isInfrastructureFault(err: unknown): boolean {
  return isTransportError(err) || isEdgeInterstitialError(err);
}
