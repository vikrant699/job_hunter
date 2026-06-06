import { logger } from "../logger.js";
import { config } from "../config.js";
import { selectAllCompanies, listNotifiedPostingsSince } from "../db/index.js";
import {
  buildSearchedCsv, buildDiscoveryCsv,
  uploadDailyCsvs, type AttachmentInput, type MatchRow, type CompanyRow,
} from "../discord/attachments.js";
import type { DiscoveryResult } from "../discovery/run.js";

/**
 * Build & post the end-of-run CSVs to Discord (two sheets):
 *
 *   - searched-YYYY-MM-DD.csv   : what this tick produced — one row per matched
 *                                  posting (Kind=match) plus one row per errored /
 *                                  unchecked company (Kind=company) that needs a fix.
 *                                  Companies that fetched fine with zero matches are
 *                                  intentionally omitted (they were noise).
 *   - discovery-YYYY-MM-DD.csv  : new candidates we added (or considered + rejected)
 *
 * A company is a "company" row when it was NOT fetched this tick or needs
 * attention (broken / manual); the fetch window is `last_fetched_at >= tickStartedAt`.
 */

function todayStamp(iso?: string): string {
  return (iso ?? new Date().toISOString()).slice(0, 10);
}

function isFetchable(strategy: string): boolean {
  return strategy === "ats-api" || strategy === "llm-scrape" || strategy === "playwright-llm-scrape";
}

function classifyUnchecked(c: { status: string; parsingStrategy: string; lastError: string | null }): string {
  if (c.status === "broken") return `broken (${c.lastError?.slice(0, 80) ?? "5+ failures"})`;
  if (c.status === "dormant") return "dormant";
  if (c.parsingStrategy === "manual") return "manual (no adapter / awaiting URL)";
  if (!isFetchable(c.parsingStrategy)) return `unfetchable strategy: ${c.parsingStrategy}`;
  return "not selected this tick";
}

export interface DailyReportInput {
  tickStartedAt: string;
  tickEndedAt: string;
  discovery: DiscoveryResult | null;
  stats: {
    postingsSeen: number;
    postingsNew: number;
    postingsGreen: number;
    postingsYellow: number;
    postingsTitleDenied: number;
    errors: string[];
    durationMs: number;
  };
}

export async function emitDailyCsvs(input: DailyReportInput): Promise<void> {
  const { tickStartedAt, tickEndedAt, discovery, stats } = input;
  const stamp = todayStamp(tickEndedAt);

  const matchRows: MatchRow[] = listNotifiedPostingsSince(tickStartedAt);

  const all = selectAllCompanies();
  const companyRows: CompanyRow[] = [];
  for (const c of all) {
    // Denied companies are permanently off-list (services denylist) — not actionable.
    if (c.status === "denied") continue;

    // A company is "needs attention" when broken/manual, or simply was not
    // fetched this tick. Anything fetched fine this tick is represented by its
    // match rows above (or omitted if it produced nothing).
    const needsAttention = c.status === "broken" || c.parsingStrategy === "manual";
    const wasFetched = c.lastFetchedAt !== null && c.lastFetchedAt >= tickStartedAt;
    if (wasFetched && !needsAttention) continue;

    companyRows.push({
      company: c.name,
      reason: classifyUnchecked({ status: c.status, parsingStrategy: c.parsingStrategy, lastError: c.lastError }),
    });
  }
  companyRows.sort((a, b) => a.reason.localeCompare(b.reason) || a.company.localeCompare(b.company));

  const discoveryRows: Array<{
    outcome: "added" | "skipped"; name: string; careersUrl: string;
    source: string; strategy: string; detail: string;
  }> = [];
  if (discovery) {
    for (const a of discovery.additions) {
      discoveryRows.push({
        outcome: "added",
        name: a.name,
        careersUrl: a.careers_url,
        source: a.discovered_via ?? "?",
        strategy: a.parsing_strategy,
        detail: a.evidence ?? "",
      });
    }
    for (const s of discovery.skipped) {
      discoveryRows.push({
        outcome: "skipped",
        name: s.name,
        careersUrl: s.careersUrl,
        source: s.source,
        strategy: "—",
        detail: s.reason,
      });
    }
  }

  interface EmbedField { name: string; value: string; inline: boolean }
  interface DiscordEmbed { title: string; color: number; timestamp: string; fields: EmbedField[] }

  const embed: DiscordEmbed = {
    title: `${config.discord.titlePrefix} daily report`,
    color: stats.errors.length > 0 ? 0xe67e22 : 0x2ecc71,
    timestamp: tickEndedAt,
    fields: [
      { name: "Matches", value: String(matchRows.length), inline: true },
      { name: "Needs attention", value: String(companyRows.length), inline: true },
      { name: "Duration", value: `${Math.round(stats.durationMs / 1000)}s`, inline: true },
      { name: "Postings seen", value: String(stats.postingsSeen), inline: true },
      { name: "Green",  value: String(stats.postingsGreen),  inline: true },
      { name: "Yellow", value: String(stats.postingsYellow), inline: true },
    ],
  };
  if (stats.postingsTitleDenied > 0) {
    embed.fields.push(
      { name: "Title-denied", value: String(stats.postingsTitleDenied), inline: true }
    );
  }
  if (discovery) {
    embed.fields.push(
      { name: "Discovery added",  value: String(discovery.additions.length), inline: true },
      { name: "Discovery skipped", value: String(discovery.skipped.length), inline: true },
      { name: "Brave quota used", value: `${discovery.braveQuotaUsed}/${discovery.braveQuotaCap}`, inline: true },
    );
  }
  if (stats.errors.length > 0) {
    embed.fields.push({
      name: `Errors (${stats.errors.length})`,
      value: stats.errors.slice(0, 5).join("\n").slice(0, 900),
      inline: false,
    });
  }

  const files: AttachmentInput[] = [
    { filename: `searched-${stamp}.csv`, content: buildSearchedCsv(matchRows, companyRows) },
  ];
  if (discoveryRows.length > 0) {
    files.push({ filename: `discovery-${stamp}.csv`, content: buildDiscoveryCsv(discoveryRows) });
  }

  try {
    await uploadDailyCsvs({ embeds: [embed] }, files);
    logger.info(
      { matches: matchRows.length, needsAttention: companyRows.length, discovery: discoveryRows.length, files: files.length },
      "daily CSVs posted to Discord"
    );
  } catch (err) {
    logger.error({ err: String(err) }, "daily CSV upload failed");
  }
}
