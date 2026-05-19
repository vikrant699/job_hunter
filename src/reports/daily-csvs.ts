import { logger } from "../logger.js";
import { config } from "../config.js";
import { selectAllCompanies, tallyPostingsSince } from "../db/index.js";
import {
  buildSearchedCsv, buildUncheckedCsv, buildDiscoveryCsv,
  uploadDailyCsvs, type AttachmentInput,
} from "../discord/csv.js";
import type { DiscoveryResult } from "../discovery/run.js";

/**
 * Build & post the end-of-day CSVs to Discord.
 *
 *   - searched-YYYY-MM-DD.csv   : every company we tried to fetch this tick
 *   - skipped-YYYY-MM-DD.csv    : every company in the registry we did NOT fetch
 *                                  (denylist / manual / broken / etc.) + reason
 *   - discovery-YYYY-MM-DD.csv  : new candidates we added (or considered + rejected)
 *
 * Tick-window filter uses `last_fetched_at >= tickStartedAt` on the companies
 * table; anything else in the registry is "skipped".
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

  // ----- Searched + Unchecked -----
  const all = selectAllCompanies();
  const tally = tallyPostingsSince(tickStartedAt);

  const searchedRows: Array<{
    name: string; careersUrl: string; source: string; strategy: string;
    postingsSeen: number; green: number; yellow: number; status: string; error: string | null;
  }> = [];
  const uncheckedRows: Array<{
    name: string; careersUrl: string; reason: string; source: string; status: string;
  }> = [];

  for (const c of all) {
    // We intentionally do NOT include denied companies in either CSV — they're
    // permanently off-list (services denylist) and not actionable.
    if (c.status === "denied") continue;

    // Route broken/manual into the unchecked CSV regardless of whether
    // they were attempted today — these are the entries we need to fix in
    // the weekly review (you + me), and grouping them together makes the
    // CSV easier to read.
    const needsAttention = c.status === "broken" || c.parsingStrategy === "manual";
    const wasFetched = c.lastFetchedAt !== null && c.lastFetchedAt >= tickStartedAt;

    if (wasFetched && !needsAttention) {
      const t = tally.get(`${c.provider}::${c.slug}`) ?? { totalNew: 0, green: 0, yellow: 0 };
      searchedRows.push({
        name: c.name,
        careersUrl: c.careersUrl,
        source: c.provider,
        strategy: c.parsingStrategy,
        postingsSeen: t.totalNew,
        green: t.green,
        yellow: t.yellow,
        status: c.status,
        error: c.lastError ?? null,
      });
    } else {
      uncheckedRows.push({
        name: c.name,
        careersUrl: c.careersUrl,
        reason: classifyUnchecked({ status: c.status, parsingStrategy: c.parsingStrategy, lastError: c.lastError }),
        source: c.provider,
        status: c.status,
      });
    }
  }

  searchedRows.sort((a, b) => b.green - a.green || b.yellow - a.yellow || b.postingsSeen - a.postingsSeen);
  uncheckedRows.sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name));

  // ----- Discovery -----
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

  // ----- Compose embed + post -----
  const embed: Record<string, unknown> = {
    title: `${config.discord.titlePrefix} daily report`,
    color: stats.errors.length > 0 ? 0xe67e22 : 0x2ecc71,
    timestamp: tickEndedAt,
    fields: [
      { name: "Searched", value: String(searchedRows.length), inline: true },
      { name: "Unchecked", value: String(uncheckedRows.length), inline: true },
      { name: "Duration", value: `${Math.round(stats.durationMs / 1000)}s`, inline: true },
      { name: "Postings seen", value: String(stats.postingsSeen), inline: true },
      { name: "Green",  value: String(stats.postingsGreen),  inline: true },
      { name: "Yellow", value: String(stats.postingsYellow), inline: true },
    ],
  };
  if (stats.postingsTitleDenied > 0) {
    (embed.fields as Array<{ name: string; value: string; inline: boolean }>).push(
      { name: "Title-denied", value: String(stats.postingsTitleDenied), inline: true }
    );
  }
  if (discovery) {
    (embed.fields as Array<{ name: string; value: string; inline: boolean }>).push(
      { name: "Discovery added",  value: String(discovery.additions.length), inline: true },
      { name: "Discovery skipped", value: String(discovery.skipped.length), inline: true },
      { name: "Brave quota used", value: `${discovery.braveQuotaUsed}/${discovery.braveQuotaCap}`, inline: true },
    );
  }
  if (stats.errors.length > 0) {
    (embed.fields as Array<{ name: string; value: string; inline: boolean }>).push({
      name: `Errors (${stats.errors.length})`,
      value: stats.errors.slice(0, 5).join("\n").slice(0, 900),
      inline: false,
    });
  }

  const files: AttachmentInput[] = [
    { filename: `searched-${stamp}.csv`,  content: buildSearchedCsv(searchedRows) },
    { filename: `unchecked-${stamp}.csv`, content: buildUncheckedCsv(uncheckedRows) },
  ];
  if (discoveryRows.length > 0) {
    files.push({ filename: `discovery-${stamp}.csv`, content: buildDiscoveryCsv(discoveryRows) });
  }

  try {
    await uploadDailyCsvs({ embeds: [embed] }, files);
    logger.info(
      { searched: searchedRows.length, unchecked: uncheckedRows.length, discovery: discoveryRows.length, files: files.length },
      "daily CSVs posted to Discord"
    );
  } catch (err) {
    logger.error({ err: String(err) }, "daily CSV upload failed");
  }
}
