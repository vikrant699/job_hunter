// src/blast/run.ts
//
// One weekly blast run: bounce sweep -> safety guards -> candidate pool ->
// MX gate -> render + create drafts (state flushed per draft) -> Blast Log
// projection. TEMPORARY tool (design spec
// docs/superpowers/specs/2026-07-09-divya-blast-design.md); never sends mail
// and touches no job_hunter DB tables.
import { readFileSync } from "node:fs";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { buildDraftMime } from "../google/mime.js";
import { createDraft as createDraftDefault, searchMessages as searchMessagesDefault, getMessageMetadata as getMessageMetadataDefault } from "../google/gmail.js";
import type { CreatedDraft, MessageRef, MessageMetadata } from "../google/gmail.js";
import {
  readTab as readTabDefault,
  ensureTabs as ensureTabsDefault,
  rewriteTab as rewriteTabDefault,
} from "../google/sheets.js";
import { sleep } from "../util/sleep.js";
import { loadState, loadAllStates, saveState, statePathFor, knownEmails, draftedEverCount, maxBatch } from "./state.js";
import type { BlastState } from "./state.js";
import { buildPool } from "./pool.js";
import { MxChecker } from "./mx.js";
import type { MxResolver } from "./mx.js";
import { loadBlastTemplate, loadBlastContent, renderBlast } from "./render.js";
import { sweepBounces } from "./bounces.js";

export const BLAST_LOG_TAB = "Blast Log";
const DRAFT_GAP_MS = 1_000;
/** "Already drafted this week" guard: refuse a new batch when the newest
 *  drafted record is younger than this many days (override with --force). */
const SAME_WEEK_DAYS = 5;
/** Stop-loss: refuse to draft when the last batch bounced above this rate. */
const MAX_BOUNCE_RATE_PCT = 10;

export interface BlastDeps {
  readTab: (profileId: string, tab: string) => Promise<string[][]>;
  ensureTabs: (profileId: string, names: string[]) => Promise<void>;
  rewriteTab: (profileId: string, tab: string, header: string[], rows: string[][]) => Promise<void>;
  createDraft: (profileId: string, mime: string) => Promise<CreatedDraft>;
  searchMessages: (profileId: string, q: string) => Promise<MessageRef[]>;
  getMessageMetadata: (profileId: string, id: string) => Promise<MessageMetadata>;
  readFile: (path: string) => Buffer;
  /** undefined -> MxChecker's real node:dns resolver. */
  mxResolver: MxResolver | undefined;
  /** ALL profiles' states for the shared Blast Log projection (a rewrite from
   *  one profile must never wipe another profile's rows). */
  listStates: () => { profileId: string; state: BlastState }[];
  now: () => Date;
  sleepMs: (ms: number) => Promise<void>;
}

function defaultDeps(): BlastDeps {
  return {
    readTab: readTabDefault,
    ensureTabs: ensureTabsDefault,
    rewriteTab: rewriteTabDefault,
    createDraft: createDraftDefault,
    searchMessages: searchMessagesDefault,
    getMessageMetadata: getMessageMetadataDefault,
    readFile: (p) => readFileSync(p),
    mxResolver: undefined,
    listStates: () => loadAllStates(),
    now: () => new Date(),
    sleepMs: sleep,
  };
}

export interface BlastPaths {
  template: string;
  /** Per-profile subjects/openers/attachment-filename (user-approved wording). */
  content: string;
  /** The profile's job_hunter resume — the same PDF the outreach pipeline attaches. */
  resume: string;
  state: string;
}

export function blastPathsFor(profileId: string): BlastPaths {
  return {
    template: `config/profiles/${profileId}/blast-template.md`,
    content: `config/profiles/${profileId}/blast-content.json`,
    resume: `config/profiles/${profileId}/resume.pdf`,
    state: statePathFor(profileId),
  };
}

export interface BlastOptions {
  profileId: string;
  limit?: number;
  verifyOnly?: boolean;
  force?: boolean;
  deps?: Partial<BlastDeps>;
  /** Test override; production callers use blastPathsFor(profileId). */
  paths?: BlastPaths;
}

export interface BlastSummary {
  /** Batch number drafted this run; null in verify-only mode. */
  batch: number | null;
  drafted: number;
  skippedInvalid: number;
  sweepChecked: number;
  newlyBounced: number;
  lastBatchBounceRatePct: number | null;
  /** Pool addresses still untouched after this run. */
  remaining: number;
}

export async function runBlast(options: BlastOptions): Promise<BlastSummary> {
  const deps: BlastDeps = { ...defaultDeps(), ...options.deps };
  const limit = options.limit ?? 100;
  const verifyOnly = options.verifyOnly ?? false;
  const force = options.force ?? false;
  const { profileId } = options;
  const paths = options.paths ?? blastPathsFor(profileId);

  const state = loadState(paths.state);

  const sweep = await sweepBounces(profileId, state, deps);
  state.lastSweepAt = deps.now().toISOString();
  saveState(paths.state, state);
  const rate = sweep.lastBatch?.ratePct ?? null;
  if (sweep.newlyBounced > 0) {
    logger.warn({ newlyBounced: sweep.newlyBounced, rate }, "blast: bounce sweep found new bounces");
  }

  let drafted = 0;
  let skippedInvalid = 0;
  let batch: number | null = null;
  let remaining = 0;

  if (!verifyOnly) {
    // Fail fast on missing content before any Google write.
    const template = loadBlastTemplate(paths.template);
    const content = loadBlastContent(paths.content);
    const resume = deps.readFile(paths.resume);

    const newestDraftedMs = state.records
      .filter((r) => r.status !== "skipped_invalid")
      .reduce((m, r) => Math.max(m, new Date(r.at).getTime()), 0);
    const ageDays = (deps.now().getTime() - newestDraftedMs) / 86_400_000;
    if (newestDraftedMs > 0 && ageDays < SAME_WEEK_DAYS && !force) {
      throw new Error(
        `blast: batch ${String(maxBatch(state))} was drafted ${ageDays.toFixed(1)} days ago; ` +
          `this looks like a same-week re-run. Pass --force to draft another batch anyway.`,
      );
    }
    if (rate !== null && rate > MAX_BOUNCE_RATE_PCT && !force) {
      throw new Error(
        `blast: last batch bounce rate is ${rate.toFixed(1)}% (> ${String(MAX_BOUNCE_RATE_PCT)}%). ` +
          `Investigate the list before continuing, or pass --force to override.`,
      );
    }

    const rows = await deps.readTab(profileId, config.google.tabs.rawData);
    const pool = buildPool(rows, knownEmails(state));

    const mx = new MxChecker(deps.mxResolver);
    batch = maxBatch(state) + 1;
    let rotation = draftedEverCount(state);
    let index = 0;
    for (; index < pool.length && drafted < limit; index++) {
      const candidate = pool[index];
      if (candidate === undefined) break;
      const nowIso = deps.now().toISOString();

      if (!(await mx.hasMx(candidate.email))) {
        state.records.push({
          ...candidate, status: "skipped_invalid", batch, variant: null, draftId: null, at: nowIso, note: "no MX record",
        });
        saveState(paths.state, state);
        skippedInvalid++;
        continue;
      }

      const rendered = renderBlast({
        template, content, company: candidate.company, contactName: candidate.contactName, rotationIndex: rotation,
      });
      const mime = buildDraftMime({
        to: candidate.email,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        attachment: { filename: content.resumeFilename, mimeType: "application/pdf", content: resume },
      });
      const created = await deps.createDraft(profileId, mime);
      state.records.push({
        ...candidate, status: "drafted", batch, variant: rendered.variant, draftId: created.draftId, at: nowIso, note: null,
      });
      // Log before flushing: if saveState throws after a successful createDraft, the log is the only trace of the orphan draft.
      logger.info({ email: candidate.email, variant: rendered.variant, draftId: created.draftId, drafted: drafted + 1 }, "blast: draft created");
      // Flush BEFORE the inter-draft gap so a crash can never re-draft.
      saveState(paths.state, state);
      drafted++;
      rotation++;
      if (drafted < limit) await deps.sleepMs(DRAFT_GAP_MS);
    }
    remaining = pool.length - index;
  }

  // Shared tab: merge EVERY profile's state so this rewrite can't wipe another
  // profile's rows. The current profile's state was saved above, so re-reading
  // from disk is consistent.
  const allRows = deps.listStates().flatMap(({ profileId: pid, state: s }) =>
    s.records.map((r) => [
      pid, r.email, r.company, r.contactName ?? "", r.status, String(r.batch), r.variant ?? "", r.at, r.note ?? "",
    ]),
  );
  await deps.ensureTabs(profileId, [BLAST_LOG_TAB]);
  await deps.rewriteTab(
    profileId,
    BLAST_LOG_TAB,
    ["Profile", "Email", "Company", "Contact Name", "Status", "Batch", "Variant", "Drafted At", "Note"],
    allRows,
  );

  return {
    batch, drafted, skippedInvalid,
    sweepChecked: sweep.checked,
    newlyBounced: sweep.newlyBounced,
    lastBatchBounceRatePct: rate,
    remaining,
  };
}
