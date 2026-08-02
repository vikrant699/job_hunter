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

function hasStringCode(value: unknown): value is { code: string } {
  if (typeof value !== "object" || value === null) return false;
  // `in` narrows the property to unknown, so no assertion is needed to read it.
  if (!("code" in value)) return false;
  return typeof value.code === "string";
}

/** Walk `err` and its `cause` chain, outermost first. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let current = err;
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
 */
export function isEdgeInterstitialError(err: unknown): boolean {
  const text = describeError(err);
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
 * copied into the scheduler alone, the JD-fetch loop in pipeline/posting-pipeline.ts
 * still tested transport only, giving an edge page zero retries and silently
 * dropping the posting before it was ever inserted.
 */
export function isInfrastructureFault(err: unknown): boolean {
  return isTransportError(err) || isEdgeInterstitialError(err);
}
