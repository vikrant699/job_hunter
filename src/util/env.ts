/** Positive-integer env knob with fallback: absent/empty/garbage -> fallback. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Comma-separated env list with fallback: absent/empty -> fallback; entries trimmed, empties dropped. */
export function envList(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}
