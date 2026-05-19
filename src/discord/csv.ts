import { logger } from "../logger.js";

const WEBHOOK_TIMEOUT_MS = 30_000;
const WEBHOOK_MAX_429_RETRIES = 3;

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCsvCell(h)).join(","));
  for (const row of rows) {
    lines.push(row.map((c) => escapeCsvCell(c)).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface AttachmentInput {
  filename: string;
  content: string;
  contentType?: string;
}

export async function postWebhookWithFiles(
  webhookUrl: string,
  payload: { embeds?: unknown[]; content?: string },
  files: AttachmentInput[]
): Promise<void> {
  for (let attempt = 0; attempt <= WEBHOOK_MAX_429_RETRIES; attempt++) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const blob = new Blob([f.content], { type: f.contentType ?? "text/csv" });
      form.append(`files[${i}]`, blob, f.filename);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt < WEBHOOK_MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(Math.max(retryAfter, 0.25) * 1000, 30_000);
      logger.warn({ retryAfter, attempt }, "Discord 429 on file upload; backing off");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord ${res.status} (file upload): ${text.slice(0, 200)}`);
    }
    return;
  }
  throw new Error("Discord 429 retries exhausted on file upload");
}

/** Build the "companies searched today" CSV. */
export function buildSearchedCsv(rows: ReadonlyArray<{
  name: string;
  careersUrl: string;
  source: string;
  strategy: string;
  postingsSeen: number;
  green: number;
  yellow: number;
  status: string;
  error: string | null;
}>): string {
  return buildCsv(
    ["Company", "Careers URL", "Source", "Strategy", "Postings seen", "Green", "Yellow", "Status", "Error"],
    rows.map((r) => [r.name, r.careersUrl, r.source, r.strategy, r.postingsSeen, r.green, r.yellow, r.status, r.error ?? ""])
  );
}

/** Build the "companies unchecked today" CSV. */
export function buildUncheckedCsv(rows: ReadonlyArray<{
  name: string;
  careersUrl: string;
  reason: string;
  source: string;
  status: string;
}>): string {
  return buildCsv(
    ["Company", "Careers URL", "Reason", "Source", "Status"],
    rows.map((r) => [r.name, r.careersUrl, r.reason, r.source, r.status])
  );
}

/** Build the "discovery this run" CSV (additions + skips combined). */
export function buildDiscoveryCsv(rows: ReadonlyArray<{
  outcome: "added" | "skipped";
  name: string;
  careersUrl: string;
  source: string;
  strategy: string;
  detail: string;
}>): string {
  return buildCsv(
    ["Outcome", "Company", "Careers URL", "Source", "Strategy", "Detail"],
    rows.map((r) => [r.outcome, r.name, r.careersUrl, r.source, r.strategy, r.detail])
  );
}

/** Convenience: post to the configured DISCORD_WEBHOOK_URL with files. */
export async function uploadDailyCsvs(
  payload: { embeds?: unknown[]; content?: string },
  files: AttachmentInput[]
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.info({ files: files.map((f) => f.filename), bytes: files.reduce((n, f) => n + f.content.length, 0) },
      "[csv mocked: DISCORD_WEBHOOK_URL not set]");
    return;
  }
  if (files.length === 0) return;
  for (const f of files) {
    if (f.content.length > 5_000_000) {
      logger.warn({ filename: f.filename, bytes: f.content.length }, "CSV too large; truncating");
      f.content = f.content.slice(0, 5_000_000) + "\r\n# truncated";
    }
  }
  await postWebhookWithFiles(webhookUrl, payload, files);
}
