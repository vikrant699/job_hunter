// src/eval/metrics.ts
export interface ScoredLabel {
  score: number;
  relevant: boolean;
}

/**
 * Tie-aware ROC-AUC via the Mann–Whitney U statistic. 0.5 = no separation.
 * Returns NaN if either class is empty. Tie detection uses strict equality,
 * which assumes scores are raw parsed floats (not computed/averaged values).
 */
export function rocAuc(rows: ScoredLabel[]): number {
  const pos = rows.filter((r) => r.relevant).map((r) => r.score);
  const neg = rows.filter((r) => !r.relevant).map((r) => r.score);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      wins += p > n ? 1 : p === n ? 0.5 : 0;
    }
  }
  return wins / (pos.length * neg.length);
}

/** Fraction of relevant rows with score >= t. */
export function recallAtThreshold(rows: ScoredLabel[], t: number): number {
  const pos = rows.filter((r) => r.relevant);
  if (pos.length === 0) return NaN;
  return pos.filter((r) => r.score >= t).length / pos.length;
}

/** Fraction of kept rows (score >= t) that are relevant. */
export function precisionAtThreshold(rows: ScoredLabel[], t: number): number {
  const kept = rows.filter((r) => r.score >= t);
  if (kept.length === 0) return NaN;
  return kept.filter((r) => r.relevant).length / kept.length;
}

/** Highest threshold that still keeps every relevant row = the minimum relevant score. */
export function maxThresholdForFullRecall(rows: ScoredLabel[]): number {
  const pos = rows.filter((r) => r.relevant).map((r) => r.score);
  if (pos.length === 0) return NaN;
  return Math.min(...pos);
}

export interface SpreadStats {
  distinct: number;
  modal: number;
  modalShare: number;
}

/**
 * Distribution shape: how many distinct values, and how concentrated the top one is.
 * Ties in count are broken by first occurrence (Map insertion order).
 * Empty input yields { distinct: 0, modal: NaN, modalShare: NaN }.
 */
export function scoreSpread(scores: number[]): SpreadStats {
  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
  let modal = NaN;
  let modalCount = 0;
  for (const [v, c] of counts) {
    if (c > modalCount) { modalCount = c; modal = v; }
  }
  return {
    distinct: counts.size,
    modal,
    modalShare: scores.length > 0 ? modalCount / scores.length : NaN,
  };
}
