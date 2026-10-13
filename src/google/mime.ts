// base64 not quoted-printable, so body and attachment share one wrapping helper.

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

// Control chars are stripped first so a CRLF in a scraped company name can't inject headers.
function encodeSubject(subject: string): string {
  const sanitized = subject.replace(/[\x00-\x1f\x7f]+/g, " ");
  if (isAscii(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf-8").toString("base64")}?=`;
}

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

/** Stops sheet-sourced values smuggling extra headers into the message. */
function sanitizeHeaderValue(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

function sanitizeFilename(s: string): string {
  return sanitizeHeaderValue(s).replace(/"/g, "");
}

export function toBase64Url(s: string | Buffer): string {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf-8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
