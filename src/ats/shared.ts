export const REMOTE_RE = /remote|work from home|wfh|anywhere|virtual/i;

export function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

export function buildLocationString(
  ...parts: Array<string | null | undefined>
): string | null {
  const joined = parts.filter(Boolean).join(", ");
  return joined.length > 0 ? joined : null;
}

// Workday returns relative date strings like "Posted Today" / "5 Days Ago".
export function parsePostedOn(s: string | null): string | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  const now = new Date();

  if (lc.includes("today") || lc.includes("just")) {
    return now.toISOString();
  }
  if (lc.includes("yesterday")) {
    return new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  }
  const m = lc.match(/(\d+)\s*\+?\s*(day|week|month)s?\s*ago/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    return new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  }
  return null;
}
