// src/blast/bounces.ts
//
// Bounce sweep for blast drafts: one precise per-address Gmail query (same
// query shape as src/outreach/verify.ts's bounceSearchQuery — duplicated so
// the blast tool stays deletable). Bounced is terminal; a Gmail search that
// flakes to 0 hits later never un-bounces a record.
import type { MessageRef, MessageMetadata } from "../google/gmail.js";
import type { BlastState } from "./state.js";

/** How many days back a drafted address keeps being re-checked. Covers Divya
 *  scheduling sends across the week plus slow bounce delivery. */
const RECHECK_DAYS = 21;

/** Gmail `after:` takes epoch SECONDS (ms silently matches nothing). */
function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** The address is quoted so Gmail treats it as one phrase. */
export function bounceQuery(email: string, draftedAtIso: string): string {
  return `from:(mailer-daemon OR postmaster) "${email}" after:${String(epochSeconds(draftedAtIso))}`;
}

export interface SweepDeps {
  searchMessages: (profileId: string, q: string) => Promise<MessageRef[]>;
  getMessageMetadata: (profileId: string, id: string) => Promise<MessageMetadata>;
  now: () => Date;
}

export interface SweepResult {
  checked: number;
  newlyBounced: number;
  /** Stats for the most recent batch — the stop-loss guard's input. Null when
   *  nothing has ever been drafted. */
  lastBatch: { batch: number; total: number; bounced: number; ratePct: number } | null;
}

/** Mutates `state` records in place (drafted -> bounced); the caller saves. */
export async function sweepBounces(profileId: string, state: BlastState, deps: SweepDeps): Promise<SweepResult> {
  const cutoffMs = deps.now().getTime() - RECHECK_DAYS * 86_400_000;
  const toCheck = state.records.filter(
    (r) => r.status === "drafted" && new Date(r.at).getTime() >= cutoffMs,
  );

  let newlyBounced = 0;
  for (const rec of toCheck) {
    const hits = await deps.searchMessages(profileId, bounceQuery(rec.email, rec.at));
    const first = hits[0];
    if (first === undefined) continue;
    const meta = await deps.getMessageMetadata(profileId, first.id);
    rec.status = "bounced";
    rec.note = meta.snippet.slice(0, 140);
    newlyBounced++;
  }

  const last = state.records.reduce((m, r) => Math.max(m, r.batch), 0);
  if (last === 0) return { checked: toCheck.length, newlyBounced, lastBatch: null };
  const inBatch = state.records.filter((r) => r.batch === last && r.status !== "skipped_invalid");
  const bounced = inBatch.filter((r) => r.status === "bounced").length;
  const ratePct = inBatch.length === 0 ? 0 : (bounced / inBatch.length) * 100;
  return {
    checked: toCheck.length,
    newlyBounced,
    lastBatch: { batch: last, total: inBatch.length, bounced, ratePct },
  };
}
