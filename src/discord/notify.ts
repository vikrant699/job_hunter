import { config } from "../config.js";
import { logger } from "../logger.js";
import { profile } from "../profile.js";
import { postWebhookJson } from "./webhook.js";
import type { NormalizedPosting } from "../types.js";

function resolveWebhookUrl(): string | undefined {
  return profile.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
}

export type DiscordSeverity = "green" | "yellow";

const COLOR_GREEN = 0x2ecc71;
const COLOR_YELLOW = 0xf1c40f;

export interface NotifyInput {
  posting: NormalizedPosting;
  severity: DiscordSeverity;
  matchScore: number;
  reason: string;
  yoeMin: number | null;
  yoeMax: number | null;
  /** Used when posting.jobUrl is missing/empty — link the careers page instead. */
  fallbackCareersUrl: string;
}

function yoeField(min: number | null, max: number | null): string {
  if (min === null && max === null) return "NA";
  if (min !== null && max !== null) return `${min}–${max} years`;
  if (min !== null) return `${min}+ years`;
  return `Up to ${max} years`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function notifyPosting(input: NotifyInput): Promise<void> {
  const webhookUrl = resolveWebhookUrl();
  const p = input.posting;

  const hasDirectLink = !!p.jobUrl && p.jobUrl.trim().length > 0;
  const linkUrl = hasDirectLink ? p.jobUrl : input.fallbackCareersUrl;

  const titleBase = `${p.jobTitle} @ ${p.companyName}`;
  const linkHint = hasDirectLink ? "" : " [careers page]";
  const sevTag = input.severity === "yellow" ? " ⚠" : "";
  const title = `${config.discord.titlePrefix}${sevTag} ${titleBase}${linkHint}`;

  if (!webhookUrl) {
    logger.info(
      {
        url: linkUrl,
        jobTitle: p.jobTitle,
        company: p.companyName,
        severity: input.severity,
        matchScore: Number(input.matchScore.toFixed(2)),
        hasDirectLink,
      },
      "[notify mocked: DISCORD_WEBHOOK_URL not set]",
    );
    return;
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "YOE", value: yoeField(input.yoeMin, input.yoeMax), inline: true },
    { name: "Location", value: p.location ?? (p.isRemote ? "Remote" : "Not specified"), inline: true },
    { name: "Posted", value: fmtRelativeTime(p.postedAt), inline: true },
    { name: "Why match", value: truncate(input.reason, 200), inline: false },
  ];
  if (!hasDirectLink) {
    fields.push({
      name: "Note",
      value: "Direct posting URL not found — link goes to the company careers page.",
      inline: false,
    });
  }

  const embed = {
    title: truncate(title, 250),
    url: linkUrl,
    description: truncate(p.jdText, config.discord.embedDescriptionMaxChars),
    color: input.severity === "yellow" ? COLOR_YELLOW : COLOR_GREEN,
    fields,
    footer: { text: `${p.provider}/${p.companySlug}  ·  score: ${input.matchScore.toFixed(2)}` },
  };

  await postWebhookJson(webhookUrl, { embeds: [embed] });
}

export interface SummaryInput {
  kind: "production" | "discovery";
  companiesScanned: number;
  postingsSeen: number;
  postingsNew: number;
  postingsGreen: number;
  postingsYellow: number;
  postingsTitleDenied?: number;
  postingsDuplicated?: number;
  candidatesAdded?: number;
  durationMs: number;
  errors: string[];
}

export async function notifySummary(input: SummaryInput): Promise<void> {
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) {
    logger.info(input, "[summary mocked: DISCORD_WEBHOOK_URL not set]");
    return;
  }

  const title =
    input.kind === "production"
      ? `${config.discord.titlePrefix} run summary`
      : `${config.discord.titlePrefix} discovery digest`;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Companies scanned", value: String(input.companiesScanned), inline: true },
    { name: "Postings seen", value: String(input.postingsSeen), inline: true },
    { name: "New postings", value: String(input.postingsNew), inline: true },
    { name: "Green matches", value: String(input.postingsGreen), inline: true },
    { name: "Yellow flags", value: String(input.postingsYellow), inline: true },
    { name: "Duration", value: `${Math.round(input.durationMs / 1000)}s`, inline: true },
  ];
  if (input.postingsTitleDenied !== undefined && input.postingsTitleDenied > 0) {
    fields.push({ name: "Title-denied", value: String(input.postingsTitleDenied), inline: true });
  }
  if (input.postingsDuplicated !== undefined && input.postingsDuplicated > 0) {
    fields.push({ name: "Duplicates suppressed", value: String(input.postingsDuplicated), inline: true });
  }
  if (input.candidatesAdded !== undefined) {
    fields.push({ name: "Candidates added", value: String(input.candidatesAdded), inline: true });
  }
  if (input.errors.length > 0) {
    fields.push({
      name: `Errors (${input.errors.length})`,
      value: truncate(input.errors.slice(0, 5).join("\n"), 800),
      inline: false,
    });
  }

  const embed = {
    title,
    color: input.errors.length > 0 ? 0xe67e22 : 0x2ecc71,
    fields,
    timestamp: new Date().toISOString(),
  };

  await postWebhookJson(webhookUrl, { embeds: [embed] });
}
