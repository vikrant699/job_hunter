import { logger } from "../logger.js";
import { config } from "../config.js";
import { selectAllCompanies, listNotifiedPostingsSince } from "../db/index.js";
import {
  buildSearchedCsv,
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

// Scrape strategies whose 0-postings result is AMBIGUOUS: it can mean a genuinely
// empty board OR a silent extraction miss (markup changed, JS didn't render, the
// LLM returned nothing). ats-api 0-results are authoritative and not suspect.
function isFragileScrape(strategy: string): boolean {
  return strategy === "llm-scrape" || strategy === "playwright-llm-scrape";
}

/**
 * A fragile-scrape company that was fetched this tick and yielded 0 postings is
 * a "suspect dry" only when it looks broken rather than just empty:
 *   - never produced a single posting (postingsSeenTotal === 0), or
 *   - its URL is already flagged suspect, or
 *   - it has gone dry for >= the dormancy threshold (3) consecutive runs.
 * `wasFetched && zeroYieldStreak >= 1` proves it saw 0 THIS tick — any seen>0
 * would have reset the streak to 0 in markFetchSuccess.
 */
const SUSPECT_DRY_STREAK = 3;
function isSuspectDry(
  c: { parsingStrategy: string; zeroYieldStreak: number; postingsSeenTotal: number; urlSuspect: boolean },
  wasFetched: boolean,
): boolean {
  if (!wasFetched || !isFragileScrape(c.parsingStrategy) || c.zeroYieldStreak < 1) return false;
  return c.postingsSeenTotal === 0 || c.urlSuspect || c.zeroYieldStreak >= SUSPECT_DRY_STREAK;
}

function suspectDryReason(c: { zeroYieldStreak: number; postingsSeenTotal: number; urlSuspect: boolean }): string {
  const n = c.zeroYieldStreak;
  const dry = `dry ${n} tick${n === 1 ? "" : "s"}`;
  if (c.postingsSeenTotal === 0) return `scraped 0 postings — never yielded (${dry})`;
  if (c.urlSuspect) return `scraped 0 postings — url suspect (${dry})`;
  return `scraped 0 postings (${dry})`;
}

export interface DailyReportInput {
  tickStartedAt: string;
  tickEndedAt: string;
  profileId: string;
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

  const matchRows: MatchRow[] = listNotifiedPostingsSince(tickStartedAt, input.profileId);

  const all = selectAllCompanies();
  const companyRows: CompanyRow[] = [];
  for (const c of all) {
    // Denied companies are permanently off-list (services denylist) — not actionable.
    if (c.status === "denied") continue;

    // A company is "needs attention" when broken/manual, or simply was not
    // fetched this tick. A company fetched fine this tick is normally represented
    // by its match rows above (or omitted as noise if it produced nothing) —
    // EXCEPT a fragile-scrape company that came back with 0 postings and looks
    // like a silent extraction failure (isSuspectDry), which we surface so a
    // genuinely-empty board can be told apart from a broken scraper.
    const needsAttention = c.status === "broken" || c.parsingStrategy === "manual";
    const wasFetched = c.lastFetchedAt !== null && c.lastFetchedAt >= tickStartedAt;
    if (wasFetched && !needsAttention) {
      if (isSuspectDry(c, wasFetched)) {
        companyRows.push({ company: c.name, reason: suspectDryReason(c) });
      }
      continue;
    }

    companyRows.push({
      company: c.name,
      reason: classifyUnchecked({ status: c.status, parsingStrategy: c.parsingStrategy, lastError: c.lastError }),
    });
  }
  companyRows.sort((a, b) => a.reason.localeCompare(b.reason) || a.company.localeCompare(b.company));

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

  try {
    await uploadDailyCsvs({ embeds: [embed] }, files);
    logger.info(
      { matches: matchRows.length, needsAttention: companyRows.length, files: files.length },
      "daily CSVs posted to Discord"
    );
  } catch (err) {
    logger.error({ err: String(err) }, "daily CSV upload failed");
  }
}
