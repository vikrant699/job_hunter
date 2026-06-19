import { config } from "../config.js";
import { logger } from "../logger.js";
import { postWebhookJson } from "./webhook.js";
import type { RunContext } from "../pipeline/index.js";

const COLOR_BLUE = 0x3498db;

export interface ProgressContext {
  /** Live run stats — read, never mutated, by the heartbeat. */
  stats: RunContext;
  /** Run start (ms epoch), for elapsed. */
  startedAt: number;
  /** Profile label so concurrent profiles are distinguishable on the shared channel. */
  profileId: string;
}

function fmtElapsed(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** "ats-api 412/412 ✓ · llm-scrape 88/520 · playwright-llm-scrape 19/140", biggest first. */
export function buildBreakdown(bp: ReadonlyMap<string, { total: number; scanned: number }>): string {
  const entries = [...bp.entries()].sort((a, b) => b[1].total - a[1].total);
  const parts = entries.map(([key, v]) => `${key} ${v.scanned}/${v.total}${v.scanned >= v.total ? " ✓" : ""}`);
  return parts.join(" · ") || "—";
}

interface ProgressEmbedField { name: string; value: string; inline: boolean }
export interface ProgressEmbed {
  title: string;
  color: number;
  fields: ProgressEmbedField[];
  timestamp: string;
}

/** Pure builder for the heartbeat embed — no I/O, so it's unit-testable. */
export function buildProgressEmbed(ctx: ProgressContext, nowMs: number): ProgressEmbed {
  const { stats, startedAt, profileId } = ctx;
  const bp = stats.bucketProgress;

  let total = 0;
  let scanned = 0;
  for (const v of bp.values()) {
    total += v.total;
    scanned += v.scanned;
  }
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
  const relevant = stats.postingsGreen + stats.postingsYellow;

  return {
    title: `${config.discord.titlePrefix} ⏳ progress`,
    color: COLOR_BLUE,
    fields: [
      { name: "Profile", value: profileId, inline: true },
      { name: "Companies", value: `${scanned} / ${total} (${pct}%)`, inline: true },
      { name: "Elapsed", value: fmtElapsed(nowMs - startedAt), inline: true },
      { name: "Jobs seen", value: String(stats.postingsSeen), inline: true },
      {
        name: "Jobs relevant",
        value: `${relevant} (${stats.postingsGreen}g / ${stats.postingsYellow}y)`,
        inline: true,
      },
      { name: "By strategy", value: truncate(buildBreakdown(bp), 1000), inline: false },
    ],
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Build and post one progress heartbeat. Never throws — a failed heartbeat must
 *  not abort or slow the run. Mock-logs when the progress webhook is unset. */
export async function postProgress(ctx: ProgressContext): Promise<void> {
  const embed = buildProgressEmbed(ctx, Date.now());

  const url = config.discord.progressWebhookUrl;
  if (!url) {
    logger.info(
      { profileId: ctx.profileId, companies: embed.fields[1]?.value, seen: ctx.stats.postingsSeen },
      "[progress mocked: DISCORD_PROGRESS_WEBHOOK_URL not set]",
    );
    return;
  }

  try {
    await postWebhookJson(url, { embeds: [embed] });
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 160) }, "progress heartbeat post failed");
  }
}

/**
 * Start a 15-min progress heartbeat over the live run context. Returns a stop()
 * that clears the interval. The timer is unref()'d so it never keeps the process
 * alive past run completion; the caller must still call stop() in a finally so no
 * heartbeat fires during post-run wrap-up.
 */
export function startProgressHeartbeat(ctx: ProgressContext): () => void {
  const timer = setInterval(() => {
    void postProgress(ctx);
  }, config.discord.progressIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
