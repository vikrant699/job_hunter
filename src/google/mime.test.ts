// src/google/mime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraftMime, toBase64Url } from "./mime.js";

test("toBase64Url: standard base64url alphabet, no padding", () => {
  // "any carnal pleasure." -> base64 "YW55IGNhcm5hbCBwbGVhc3VyZS4=" (has padding + no +/-)
  // Use bytes that are guaranteed to produce +, /, and = in standard base64.
  const buf = Buffer.from([0xfb, 0xff, 0xbf]); // base64: +/+/ variant depending on grouping
  const std = buf.toString("base64");
  const url = toBase64Url(buf);
  assert.ok(!url.includes("+"));
  assert.ok(!url.includes("/"));
  assert.ok(!url.includes("="));
  assert.equal(url, std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
});

test("toBase64Url: round-trips a string", () => {
  const original = "hello, world! éè";
  const encoded = toBase64Url(original);
  const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.equal(decoded, original);
});

test("buildDraftMime: plain-text single-part message has expected headers", () => {
  const mime = buildDraftMime({ to: "a@example.com", subject: "Hello", bodyText: "Hi there" });
  const lines = mime.split("\r\n");
  assert.ok(lines.some((l) => l === "To: a@example.com"));
  assert.ok(lines.some((l) => l === "Subject: Hello"));
  assert.ok(lines.some((l) => l === "MIME-Version: 1.0"));
  assert.ok(lines.some((l) => /^Content-Type: text\/plain; charset="?utf-8"?/i.test(l)));
  assert.ok(!mime.includes("multipart/mixed"), "no attachment -> not multipart");
});

test("buildDraftMime: uses CRLF line endings throughout", () => {
  const mime = buildDraftMime({ to: "a@example.com", subject: "Hi", bodyText: "line1\nline2" });
  assert.ok(!mime.includes("\r\r"));
  // Every bare \n must be preceded by \r (i.e. no lone LF).
  const withoutCrlf = mime.split("\r\n").join("");
  assert.ok(!withoutCrlf.includes("\n"), "no lone LF should survive outside of CRLF pairs");
});

test("buildDraftMime: non-ASCII subject is RFC-2047 encoded", () => {
  const mime = buildDraftMime({ to: "a@example.com", subject: "Café résumé", bodyText: "hi" });
  const subjectLine = mime.split("\r\n").find((l) => l.startsWith("Subject:"));
  assert.ok(subjectLine);
  assert.match(subjectLine, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const b64 = subjectLine.replace(/^Subject: =\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  const decoded = Buffer.from(b64, "base64").toString("utf-8");
  assert.equal(decoded, "Café résumé");
});

test("buildDraftMime: ASCII-only subject is not encoded", () => {
  const mime = buildDraftMime({ to: "a@example.com", subject: "Plain Subject", bodyText: "hi" });
  const subjectLine = mime.split("\r\n").find((l) => l.startsWith("Subject:"));
  assert.equal(subjectLine, "Subject: Plain Subject");
});

test("buildDraftMime: with attachment produces multipart/mixed with exactly two boundary delimiters and one closing delimiter", () => {
  const mime = buildDraftMime({
    to: "a@example.com",
    subject: "With attachment",
    bodyText: "See attached",
    attachment: { filename: "resume.pdf", mimeType: "application/pdf", content: Buffer.from("PDF-CONTENT") },
  });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="([^"]+)"/);
  const boundaryMatch = /boundary="([^"]+)"/.exec(mime);
  assert.ok(boundaryMatch);
  const boundary = boundaryMatch[1];
  assert.ok(boundary);
  const openCount = mime.split(`--${boundary}\r\n`).length - 1;
  const closeCount = mime.split(`--${boundary}--`).length - 1;
  assert.equal(openCount, 2, "two part delimiters (body part + attachment part)");
  assert.equal(closeCount, 1, "exactly one closing delimiter");
  assert.match(mime, /Content-Disposition: attachment; filename="resume\.pdf"/);
  assert.match(mime, /Content-Type: application\/pdf/);
});

test("buildDraftMime: attachment content survives base64 round-trip and is wrapped at 76 chars", () => {
  const content = Buffer.from("A".repeat(200), "utf-8");
  const mime = buildDraftMime({
    to: "a@example.com",
    subject: "Attach",
    bodyText: "body",
    attachment: { filename: "data.bin", mimeType: "application/octet-stream", content },
  });
  // Extract the attachment's base64 block: everything between its Content-Disposition
  // header block and the next boundary line.
  const parts = mime.split(/\r\n--[^\r\n]+\r\n/);
  const attachmentPart = parts.find((p) => p.includes("Content-Disposition: attachment"));
  assert.ok(attachmentPart);
  const [, ...rest] = attachmentPart.split("\r\n\r\n");
  const b64Block = rest.join("\r\n\r\n").replace(/\r\n--[^\r\n]*--\r\n?$/, "").trim();
  const b64Lines = b64Block.split("\r\n");
  for (const line of b64Lines.slice(0, -1)) {
    assert.ok(line.length <= 76, `line too long: ${line.length}`);
  }
  const decoded = Buffer.from(b64Lines.join(""), "base64");
  assert.equal(decoded.toString("utf-8"), content.toString("utf-8"));
});
