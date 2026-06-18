import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { profile } from "../profile.js";

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
    } catch (err) {
      // Timeout abort or transient network failure — retry like a 429.
      if (attempt < WEBHOOK_MAX_429_RETRIES) {
        logger.warn({ attempt, err: String(err).slice(0, 120) }, "Discord file upload fetch failed; retrying");
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt < WEBHOOK_MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(Math.max(retryAfter, 0.25) * 1000, 30_000);
      logger.warn({ retryAfter, attempt }, "Discord 429 on file upload; backing off");
      await sleep(waitMs);
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

export interface MatchRow {
  company: string;
  title: string;
  url: string;
  score: number | null;
  tier: "green" | "yellow";
  reason: string;
}

export interface CompanyRow {
  company: string;
  reason: string;
}

/**
 * Build the "searched today" CSV: one row per matched posting (Kind=match)
 * followed by one row per errored / unchecked company (Kind=company, job
 * columns blank). A single Kind column disambiguates the two row shapes.
 */
export function buildSearchedCsv(
  matchRows: ReadonlyArray<MatchRow>,
  companyRows: ReadonlyArray<CompanyRow>,
): string {
  const rows: unknown[][] = [];
  for (const m of matchRows) {
    rows.push(["match", m.company, m.title, m.url, m.score ?? "", m.tier, m.reason]);
  }
  for (const c of companyRows) {
    rows.push(["company", c.company, "", "", "", "", c.reason]);
  }
  return buildCsv(
    ["Kind", "Company", "Job title", "Job URL", "Score", "Tier", "Reason/Error"],
    rows,
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
  const webhookUrl = profile.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.info({ files: files.map((f) => f.filename), bytes: files.reduce((n, f) => n + f.content.length, 0) },
      "[csv mocked: DISCORD_WEBHOOK_URL not set]");
    return;
  }
  if (files.length === 0) return;
  for (const f of files) {
    if (f.content.length > 5_000_000) {
      logger.warn({ filename: f.filename, bytes: f.content.length }, "CSV too large; truncating");
      // Cut at the last full line so we never split a quoted cell mid-value.
      const head = f.content.slice(0, 5_000_000);
      const lastBreak = head.lastIndexOf("\r\n");
      f.content = (lastBreak > 0 ? head.slice(0, lastBreak) : head) + "\r\n# truncated";
    }
  }
  await postWebhookWithFiles(webhookUrl, payload, files);
}
