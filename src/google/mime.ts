// src/google/mime.ts
//
// Pure RFC 5322 message builder for Gmail drafts. No I/O — everything here is
// deterministic string building so it can be thoroughly unit tested without
// touching the network.
//
// Body encoding choice: base64 (not quoted-printable). Quoted-printable's
// line-length/escaping rules add complexity for no benefit here since the
// body text is short and Gmail handles either transparently; base64 also
// lets the body and attachment share one wrapping helper.

const CRLF = "\r\n";
const BASE64_LINE_LENGTH = 76;

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface BuildDraftMimeInput {
  to: string;
  subject: string;
  bodyText: string;
  attachment?: DraftAttachment;
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

/**
 * RFC 2047 "B" (base64) encoded-word, used when the subject has non-ASCII chars.
 * Control characters (CR/LF above all) are stripped FIRST regardless of ASCII-ness:
 * subject text is built from scraped company names, and a CRLF smuggled through
 * an ASCII subject would otherwise inject arbitrary headers (e.g. a Bcc:) into
 * the raw RFC 5322 message.
 */
function encodeSubject(subject: string): string {
  const sanitized = subject.replace(/[\x00-\x1f\x7f]+/g, " ");
  if (isAscii(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf-8").toString("base64")}?=`;
}

/** Wrap a base64 string into CRLF-joined lines of at most `BASE64_LINE_LENGTH` chars. */
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += BASE64_LINE_LENGTH) {
    lines.push(b64.slice(i, i + BASE64_LINE_LENGTH));
  }
  return lines.join(CRLF);
}

function randomBoundary(): string {
  return `job-hunter-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Header-value sanitizer: control chars (CR/LF above all) become spaces so
 *  sheet-sourced values can never smuggle extra headers into the message. */
function sanitizeHeaderValue(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** Quoted-string-safe filename: header sanitize plus dropping double quotes. */
function sanitizeFilename(s: string): string {
  return sanitizeHeaderValue(s).replace(/"/g, "");
}

/**
 * Standard base64url encoding (RFC 4648 §5): `+`→`-`, `/`→`_`, no padding.
 * Gmail's `drafts.create`/`messages.send` raw field requires this encoding.
 */
export function toBase64Url(s: string | Buffer): string {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf-8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a complete RFC 5322 email message ready for base64url-encoding into
 * Gmail's `raw` field. Single-part text/plain when there is no attachment;
 * multipart/mixed (a text part + a base64 attachment part) otherwise.
 */
export function buildDraftMime(input: BuildDraftMimeInput): string {
  const headers = [
    `To: ${sanitizeHeaderValue(input.to)}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  if (!input.attachment) {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: base64");
    return [...headers, "", wrapBase64(Buffer.from(input.bodyText, "utf-8").toString("base64"))].join(CRLF);
  }

  const boundary = randomBoundary();
  const attachment = input.attachment;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const bodyPart = [
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(input.bodyText, "utf-8").toString("base64")),
  ].join(CRLF);

  const safeFilename = sanitizeFilename(attachment.filename);
  const attachmentPart = [
    `Content-Type: ${attachment.mimeType}; name="${safeFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "",
    wrapBase64(attachment.content.toString("base64")),
  ].join(CRLF);

  return [
    ...headers,
    "",
    `--${boundary}`,
    bodyPart,
    `--${boundary}`,
    attachmentPart,
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
