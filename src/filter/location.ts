import { profile } from "../profile.js";

export interface LocationConfig {
  targetCities: readonly string[];
  targetCountryHints: readonly string[];
  remoteAcceptStrings: readonly string[];
  rejectIfPresent: readonly string[];
  /** Whole-word matched; an in-region place alongside one overrides the reject. */
  rejectRegions?: readonly string[] | undefined;
}

export interface LocationCheck {
  accept: boolean;
  reason: string;
}

function wordBoundaryRegex(needles: readonly string[]): RegExp {
  if (needles.length === 0) return /a^/;
  const escaped = needles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

function containsRegex(needles: readonly string[]): RegExp {
  if (needles.length === 0) return /a^/;
  const escaped = needles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

interface Compiled {
  city: RegExp;
  country: RegExp;
  remote: RegExp;
  reject: RegExp;
  rejectRegions: RegExp;
}

const cache = new WeakMap<object, Compiled>();
function compile(cfg: LocationConfig): Compiled {
  let c = cache.get(cfg);
  if (!c) {
    c = {
      city: wordBoundaryRegex(cfg.targetCities),
      country: wordBoundaryRegex(cfg.targetCountryHints),
      remote: containsRegex(cfg.remoteAcceptStrings),
      reject: containsRegex(cfg.rejectIfPresent),
      rejectRegions: wordBoundaryRegex(cfg.rejectRegions ?? []),
    };
    cache.set(cfg, c);
  }
  return c;
}

export function checkLocation(
  location: string | null,
  isRemote: boolean,
  cfg: LocationConfig = profile.location,
): LocationCheck {
  if (!location) {
    return { accept: false, reason: "no-location" };
  }
  const lc = location.toLowerCase();
  const re = compile(cfg);

  if (re.reject.test(lc)) {
    return { accept: false, reason: "geo-rejected" };
  }
  // A foreign place name rejects only when no in-region signal sits beside it.
  if (re.rejectRegions.test(lc) && !(re.city.test(lc) || re.country.test(lc))) {
    return { accept: false, reason: "geo-rejected" };
  }
  if (re.remote.test(lc)) {
    return { accept: true, reason: "remote-accept" };
  }
  if (re.country.test(lc) || re.city.test(lc)) {
    return { accept: true, reason: isRemote ? "in-region-remote" : "in-region" };
  }
  return { accept: false, reason: "out-of-region" };
}

/** Host excluded: it names the company/board, not the location. */
function urlPathText(jobUrl: string): string {
  let path = jobUrl;
  try {
    path = new URL(jobUrl).pathname;
  } catch {
  }
  try {
    path = decodeURIComponent(path);
  } catch {
  }
  return path.replace(/[-_/.+]/g, " ").toLowerCase();
}

/** Recall-safe: defers to accept when unclear. */
export function checkLocationFromText(
  title: string,
  jdText: string,
  cfg: LocationConfig = profile.location,
  jobUrl?: string,
): LocationCheck {
  const t = title.toLowerCase();
  const full = jdText.toLowerCase();
  const head = full.slice(0, 2000);
  if (!t.trim() && !head.trim()) {
    return { accept: true, reason: "no-text-defer" };
  }
  const both = `${t}\n${head}`;
  const re = compile(cfg);

  // Explicit reject phrases often sit past the head window, so scan the full text for these alone.
  if (re.reject.test(`${t}\n${full}`)) {
    return { accept: false, reason: "geo-rejected" };
  }
  if (re.rejectRegions.test(t) && !(re.country.test(t) || re.city.test(t))) {
    return { accept: false, reason: "geo-rejected-title" };
  }
  if (jobUrl) {
    const u = urlPathText(jobUrl);
    if (
      re.rejectRegions.test(u) &&
      !(re.country.test(u) || re.city.test(u) || re.country.test(t) || re.city.test(t))
    ) {
      return { accept: false, reason: "geo-rejected-url" };
    }
  }
  // A "Location:" label line is authoritative, unlike prose mentions in the JD.
  const locLine = /^[ \t]*location[ \t]*[:–-][ \t]*(.+)$/im.exec(full)?.[1];
  if (locLine && re.rejectRegions.test(locLine) && !(re.country.test(locLine) || re.city.test(locLine))) {
    return { accept: false, reason: "geo-rejected-jd-location" };
  }
  if (re.remote.test(both)) {
    return { accept: true, reason: "remote-accept-text" };
  }
  if (re.country.test(both) || re.city.test(both)) {
    return { accept: true, reason: "in-region-text" };
  }
  return { accept: true, reason: "unknown-defer" };
}
