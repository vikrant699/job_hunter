import { config } from "../config.js";
import { logger } from "../logger.js";
import { postWebhookJson } from "./webhook.js";
import type { ProductionTickOutcome } from "../pipeline/index.js";
import type { VerifyResult } from "../outreach/verify.js";
import type { RunOutreachResult } from "../outreach/run.js";
import type { InstahyreResult } from "../instahyre/autoApply.js";

const COLOR_GREEN = 0x2ecc71;
const COLOR_ORANGE = 0xe67e22;

export interface RegistrySyncSummary {
  source: string;
  invalidRows: number;
}

export interface StatusInput {
  profileId: string;
  stats: ProductionTickOutcome["stats"];
  outreach: RunOutreachResult | null;
  outreachError: string | null;
  verify: VerifyResult | null;
  registry: RegistrySyncSummary | null;
  instahyre: InstahyreResult | null;
}

/** Group failed boards by reason tag into a compact, Discord-field-safe string
 *  (max ~1024 chars). e.g. "timeout ×122: bosch, abb, adobe … (+40) · 404 ×2: …". */
export function buildIssueList(
  failed: ReadonlyArray<{ provider: string; slug: string; reason: string }>,
  maxLen = 1000,
): string {
  if (failed.length === 0) return "none 🎉";
  const byReason = new Map<string, string[]>();
  for (const f of failed) {
    const arr = byReason.get(f.reason) ?? [];
    arr.push(f.slug);
    byReason.set(f.reason, arr);
  }
  const groups = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  const parts: string[] = [];
  for (const [reason, slugs] of groups) {
    const shown: string[] = [];
    let extra = 0;
    for (const s of slugs) {
      if (shown.join(", ").length < 220) shown.push(s);
      else extra++;
    }
    const tail = extra > 0 ? ` (+${extra})` : "";
    parts.push(`**${reason} ×${slugs.length}**: ${shown.join(", ")}${tail}`);
  }
  let out = parts.join("\n");
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + "…";
  return out;
}

// Type aliases, not interfaces: postWebhookJson's JsonValue param needs the implicit index signature.
type StatusEmbedField = { name: string; value: string; inline: boolean };
export type StatusEmbed = {
  title: string;
  color: number;
  fields: StatusEmbedField[];
};

function spreadsheetUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${config.google.spreadsheetId}`;
}

/** Pure builder for the single end-of-run status embed, no I/O. */
export function buildStatusEmbed(input: StatusInput): StatusEmbed {
  const { stats } = input;

  const fields: StatusEmbedField[] = [
    { name: "Companies scanned", value: String(stats.companiesScanned), inline: true },
    { name: "Postings seen", value: String(stats.postingsSeen), inline: true },
    { name: "New postings", value: String(stats.postingsNew), inline: true },
    { name: "Green", value: String(stats.postingsGreen), inline: true },
    { name: "Yellow", value: String(stats.postingsYellow), inline: true },
    { name: "JD fetch failed", value: String(stats.jdFetchFailed), inline: true },
    { name: "Boards with issues", value: String(stats.failedCompanies.length), inline: true },
    { name: "Errors", value: String(stats.errors.length), inline: true },
  ];

  // Separate from "Errors": a network outage tripping N boards is one event, not N broken vendors.
  if (stats.transportRetried > 0 || stats.transportRecovered > 0) {
    fields.push({
      name: "Transport faults",
      value: `${stats.transportRetried} retried, ${stats.transportRecovered} recovered on the deferred pass`,
      inline: false,
    });
  }

  if (stats.failedCompanies.length > 0) {
    fields.push({
      name: `Companies with issues (${stats.failedCompanies.length})`,
      value: buildIssueList(stats.failedCompanies),
      inline: false,
    });
  }

  if (input.verify) {
    fields.push({
      name: "Verify",
      value:
        `checked ${input.verify.checkedDrafts}, sent ${input.verify.sent}, ` +
        `discarded ${input.verify.discarded}, bounced ${input.verify.bounced}, verified ${input.verify.verified}`,
      inline: false,
    });
  }

  if (input.outreach) {
    fields.push(
      { name: "Drafts created", value: String(input.outreach.draftsCreated), inline: true },
      { name: "Undrafted", value: String(input.outreach.undrafted), inline: true },
      { name: "Companies matched", value: String(input.outreach.companiesMatched), inline: true },
    );
  } else if (input.outreachError) {
    fields.push({ name: "Outreach error", value: input.outreachError, inline: false });
  }

  if (input.registry) {
    fields.push({
      name: "Registry",
      value: `source: ${input.registry.source}, invalid rows: ${input.registry.invalidRows}`,
      inline: false,
    });
  }

  if (input.instahyre) {
    const { instahyre } = input;
    const value = instahyre.error
      ? `error: ${instahyre.error}`
      : instahyre.skippedReason
        ? `skipped: ${instahyre.skippedReason}`
        : `applied ${instahyre.applied}, confirmed ${instahyre.confirmed}`;
    fields.push({ name: "Instahyre", value, inline: false });
  }

  fields.push({ name: "Spreadsheet", value: spreadsheetUrl(), inline: false });

  const registryStale = input.registry?.source === "cache";
  return {
    title: `${config.discord.titlePrefix} run complete — ${input.profileId}`,
    color:
      input.outreachError || stats.errors.length > 0 || registryStale || input.instahyre?.error
        ? COLOR_ORANGE
        : COLOR_GREEN,
    fields,
  };
}

/** Post the single end-of-run status embed to the shared progress webhook; mock-logs when unset. */
export async function postRunStatus(input: StatusInput): Promise<void> {
  const embed = buildStatusEmbed(input);
  const url = config.discord.progressWebhookUrl;

  if (!url) {
    logger.info(
      { profileId: input.profileId, outreach: input.outreach, outreachError: input.outreachError },
      "[status mocked: DISCORD_PROGRESS_WEBHOOK_URL not set]",
    );
    return;
  }

  await postWebhookJson(url, { embeds: [embed] });
}
