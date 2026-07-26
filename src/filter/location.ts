import { profile } from "../profile.js";

export interface LocationConfig {
  targetCities: readonly string[];
  targetCountryHints: readonly string[];
  remoteAcceptStrings: readonly string[];
  rejectIfPresent: readonly string[];
  /** Distinctive out-of-region place names (cities/states/countries), whole-word
   *  matched. Applied to the metadata location field in checkLocation(), and to
   *  the TITLE (never the JD body) in checkLocationFromText() — so a foreign HQ
   *  mentioned only in the JD body does not reject an otherwise in-region role.
   *  In both paths, an in-region city/country alongside the foreign one overrides
   *  the reject (multi-location postings like "Bengaluru | New York" stay in). */
  rejectRegions?: readonly string[] | undefined;
}

export interface LocationCheck {
  accept: boolean;
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
    return { accept: false, reason: "no-location" };
  }
  const lc = location.toLowerCase();
  const re = compile(cfg);

  if (re.reject.test(lc)) {
    return { accept: false, reason: "geo-rejected" };
  }
  // Foreign place name rejects only when no in-region signal sits beside it —
  // multi-location postings ("Bengaluru, India; New York, NY") must survive.
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

/** The job URL's PATH as plain words: decoded, with slug separators flattened
 *  to spaces so multi-word regions ("new york" in ".../new-york-123") match.
 *  The host is deliberately excluded — a foreign word there names the company
 *  or its board, not the role's location. */
function urlPathText(jobUrl: string): string {
  let path = jobUrl;
  try {
    path = new URL(jobUrl).pathname;
  } catch {
    // not an absolute URL — scan the raw string rather than dropping the signal
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // malformed escape — keep the encoded form
  }
  return path.replace(/[-_/.+]/g, " ").toLowerCase();
}

/**
 * Late-stage check for postings that arrived without a metadata location field
 * (i.e. llm-scrape / custom). Scans the TITLE, the first ~2000 chars of the JD,
 * and the job URL's path.
 *
 * Recall-safe by design:
 *   - An explicit out-of-region phrase ("US only") anywhere → reject.
 *   - A clearly-foreign place named in the TITLE → reject (the title carries the
 *     role's location for title-embedded scrapes like DoorDash's "… Sydney, NSW").
 *     Title-only, so a foreign HQ mentioned in the JD body does NOT reject an
 *     in-region role.
 *   - A clearly-foreign place in the URL SLUG → reject (boards like Zoom put the
 *     role's location only in the URL: ".../senior-front-end-engineer-remote-brazil-…").
 *     An in-region signal in the title or the URL overrides, as with titles.
 *   - A positive in-region signal anywhere → accept.
 *   - Otherwise defer (accept) and let the LLM gate make the final call.
 */
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

  // Explicit reject phrases ("US only", work-authorization boilerplate) are
  // unambiguous wherever they sit — and they usually sit at the BOTTOM of the
  // JD, past the head window — so scan the whole text for these alone.
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
  // An explicit "Location: …" label line in the JD carries the role's location
  // (Confido's JD led with "Location: New York, NY") — unlike prose mentions,
  // which stay recall-safe and never reject. In-region beside it overrides.
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
