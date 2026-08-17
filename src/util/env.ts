/** Positive-integer env knob with fallback: absent/empty/garbage -> fallback. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Boolean env knob: only exact "true"/"false" (case-insensitive) are honoured, so a typo falls back rather than silently switching providers. */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return fallback;
}
