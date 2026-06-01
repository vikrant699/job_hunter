import { profile } from "../profile.js";

export interface LocationConfig {
  targetCities: readonly string[];
  targetCountryHints: readonly string[];
  remoteAcceptStrings: readonly string[];
  rejectIfPresent: readonly string[];
  /** Distinctive out-of-region place names (cities/states/countries). Matched
   *  word-boundary against a posting's TITLE (and any location field), so a
   *  foreign HQ mentioned only in the JD body does not reject an in-region role. */
  rejectRegions?: readonly string[];
}

export interface LocationCheck {
  accept: boolean;
  isRemoteInRegion: boolean;
  reason: string;
}

function wordBoundaryRegex(needles: readonly string[]): RegExp {
  if (needles.length === 0) return /a^/; // never matches
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

// Compiling the alternations once per config object keeps the per-posting hot
// path cheap. Keyed on the config reference (the profile singleton in prod).
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

/**
 * Decide whether a posting's metadata location field is acceptable (in-region or
 * acceptable-remote). `isRemote` comes from the provider when it tags the posting
 * as remote.
 */
export function checkLocation(
  location: string | null,
  isRemote: boolean,
  cfg: LocationConfig = profile.location,
): LocationCheck {
  if (!location) {
    return { accept: false, isRemoteInRegion: false, reason: "no-location" };
  }
  const lc = location.toLowerCase();
  const re = compile(cfg);

  if (re.reject.test(lc) || re.rejectRegions.test(lc)) {
    return { accept: false, isRemoteInRegion: false, reason: "geo-rejected" };
  }
  if (re.remote.test(lc)) {
    return { accept: true, isRemoteInRegion: true, reason: "remote-accept" };
  }
  if (re.country.test(lc) || re.city.test(lc)) {
    return {
      accept: true,
      isRemoteInRegion: isRemote,
      reason: isRemote ? "in-region-remote" : "in-region",
    };
  }
  return { accept: false, isRemoteInRegion: false, reason: "out-of-region" };
}

/**
 * Late-stage check for postings that arrived without a metadata location field
 * (i.e. llm-scrape / custom). Scans the TITLE and the first ~2000 chars of the JD.
 *
 * Recall-safe by design:
 *   - An explicit out-of-region phrase ("US only") anywhere → reject.
 *   - A clearly-foreign place named in the TITLE → reject (the title carries the
 *     role's location for title-embedded scrapes like DoorDash's "… Sydney, NSW").
 *     Title-only, so a foreign HQ mentioned in the JD body does NOT reject an
 *     in-region role.
 *   - A positive in-region signal anywhere → accept.
 *   - Otherwise defer (accept) and let the LLM gate make the final call.
 */
export function checkLocationFromText(
  title: string,
  jdText: string,
  cfg: LocationConfig = profile.location,
): LocationCheck {
  const t = (title ?? "").toLowerCase();
  const head = (jdText ?? "").slice(0, 2000).toLowerCase();
  if (!t.trim() && !head.trim()) {
    return { accept: true, isRemoteInRegion: false, reason: "no-text-defer" };
  }
  const both = `${t}\n${head}`;
  const re = compile(cfg);

  if (re.reject.test(both)) {
    return { accept: false, isRemoteInRegion: false, reason: "geo-rejected" };
  }
  if (re.rejectRegions.test(t) && !(re.country.test(t) || re.city.test(t))) {
    return { accept: false, isRemoteInRegion: false, reason: "geo-rejected-title" };
  }
  if (re.remote.test(both)) {
    return { accept: true, isRemoteInRegion: true, reason: "remote-accept-text" };
  }
  if (re.country.test(both) || re.city.test(both)) {
    return { accept: true, isRemoteInRegion: false, reason: "in-region-text" };
  }
  return { accept: true, isRemoteInRegion: false, reason: "unknown-defer" };
}

/** @deprecated retained for compatibility; prefer checkLocationFromText(title, jdText). */
export function checkLocationFromJd(
  jdText: string,
  cfg: LocationConfig = profile.location,
): LocationCheck {
  return checkLocationFromText("", jdText, cfg);
}
