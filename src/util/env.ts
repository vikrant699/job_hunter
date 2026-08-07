/** Positive-integer env knob with fallback: absent/empty/garbage -> fallback. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Boolean env knob with fallback, same contract as envInt: absent/empty/garbage
 * -> fallback. Only the exact words "true"/"false" (case-insensitive, trimmed)
 * are honoured - "1"/"yes"/"on" deliberately fall back rather than being guessed
 * at, so a typo in LOCAL keeps the run on its default provider instead of
 * silently switching to the metered one.
 */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return fallback;
}
