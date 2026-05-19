import { profile } from "../profile.js";

const cityRe = buildWordBoundaryRegex(profile.location.targetCities);
const countryRe = buildWordBoundaryRegex(profile.location.targetCountryHints);
const remoteAcceptRe = buildContainsRegex(profile.location.remoteAcceptStrings);
const rejectRe = buildContainsRegex(profile.location.rejectIfPresent);

function buildWordBoundaryRegex(needles: readonly string[]): RegExp {
  if (needles.length === 0) return /a^/; // never matches
  const escaped = needles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

function buildContainsRegex(needles: readonly string[]): RegExp {
  if (needles.length === 0) return /a^/;
  const escaped = needles.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

export interface LocationCheck {
  accept: boolean;
  isRemoteInRegion: boolean;
  reason: string;
}

/**
 * Decide whether a posting's location field is acceptable (in-region or
 * acceptable-remote). `isRemote` comes from the provider when it tags the
 * posting as remote.
 */
export function checkLocation(location: string | null, isRemote: boolean): LocationCheck {
  if (!location) {
    return { accept: false, isRemoteInRegion: false, reason: "no-location" };
  }

  const lc = location.toLowerCase();

  if (rejectRe.test(lc)) {
    return { accept: false, isRemoteInRegion: false, reason: "geo-rejected" };
  }

  if (remoteAcceptRe.test(lc)) {
    return { accept: true, isRemoteInRegion: true, reason: "remote-accept" };
  }

  if (countryRe.test(lc) || cityRe.test(lc)) {
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
 * (i.e. llm-scrape). Scans the first ~2000 chars of the JD body. Permissive on
 * uncertainty — accepts if no explicit foreign-only signal is found, so the
 * LLM gate makes the final call.
 */
export function checkLocationFromJd(jdText: string): LocationCheck {
  if (!jdText) return { accept: true, isRemoteInRegion: false, reason: "no-jd-defer" };
  const head = jdText.slice(0, 2000).toLowerCase();

  if (rejectRe.test(head)) {
    return { accept: false, isRemoteInRegion: false, reason: "geo-rejected-jd" };
  }
  if (remoteAcceptRe.test(head)) {
    return { accept: true, isRemoteInRegion: true, reason: "remote-accept-jd" };
  }
  if (countryRe.test(head) || cityRe.test(head)) {
    return { accept: true, isRemoteInRegion: false, reason: "in-region-jd" };
  }
  return { accept: true, isRemoteInRegion: false, reason: "unknown-defer" };
}
