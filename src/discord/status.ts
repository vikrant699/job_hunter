import { config } from "../config.js";
import { logger } from "../logger.js";
import { postWebhookJson } from "./webhook.js";
import type { ProductionTickOutcome } from "../pipeline/index.js";
import type { VerifyResult } from "../outreach/verify.js";

const COLOR_GREEN = 0x2ecc71;
const COLOR_ORANGE = 0xe67e22;

export interface OutreachSummary {
  draftsCreated: number;
  undrafted: number;
  companiesMatched: number;
}

export interface StatusInput {
  profileId: string;
  stats: ProductionTickOutcome["stats"];
  outreach: OutreachSummary | null;
  outreachError: string | null;
  verify: VerifyResult | null;
}

interface StatusEmbedField { name: string; value: string; inline: boolean }
export interface StatusEmbed {
  title: string;
  color: number;
  fields: StatusEmbedField[];
}

function spreadsheetUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${config.google.spreadsheetId}`;
}

/** Pure builder for the single end-of-run status embed — no I/O, unit-testable. */
export function buildStatusEmbed(input: StatusInput): StatusEmbed {
  const { stats } = input;

  const fields: StatusEmbedField[] = [
    { name: "Companies scanned", value: String(stats.companiesScanned), inline: true },
    { name: "Postings seen", value: String(stats.postingsSeen), inline: true },
    { name: "New postings", value: String(stats.postingsNew), inline: true },
    { name: "Green", value: String(stats.postingsGreen), inline: true },
    { name: "Yellow", value: String(stats.postingsYellow), inline: true },
    { name: "JD fetch failed", value: String(stats.jdFetchFailed), inline: true },
    { name: "Errors", value: String(stats.errors.length), inline: true },
  ];

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

  fields.push({ name: "Spreadsheet", value: spreadsheetUrl(), inline: false });

  return {
    title: `${config.discord.titlePrefix} run complete — ${input.profileId}`,
    color: input.outreachError || stats.errors.length > 0 ? COLOR_ORANGE : COLOR_GREEN,
    fields,
  };
}

/** Post the single end-of-run status embed to the shared progress webhook.
 *  Mock-logs when the webhook is unset (mirrors the old notify.ts pattern). */
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
