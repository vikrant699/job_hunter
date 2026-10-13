export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function envList(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}
