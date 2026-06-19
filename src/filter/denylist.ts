import { profile } from "../profile.js";
import { NOISE_DENYLIST_SLUGS } from "./noise-denylist.js";

/**
 * Cheap pre-filter: is this company on the user's services/staffing denylist, or
 * on the confirmed-noise denylist (removed companies that must never be re-added)?
 * Returning true is a hard deny — the LLM gate is never invoked for the company.
 */
export function isDeniedCompany(name: string, slug: string): { denied: boolean; reason: string | null } {
  const slugLc = slug.toLowerCase();

  // Confirmed-noise removals — block re-discovery of companies we deleted.
  const noise = NOISE_DENYLIST_SLUGS[slugLc];
  if (noise) {
    return { denied: true, reason: `noise:${noise}` };
  }

  for (const frag of profile.servicesDenylist.slugFragments) {
    if (slugLc.includes(frag)) {
      return { denied: true, reason: `services-slug:${frag}` };
    }
  }

  for (const pattern of profile.servicesDenylist.namePatterns) {
    if (pattern.test(name)) {
      return { denied: true, reason: `services-name:${pattern.source}` };
    }
  }

  return { denied: false, reason: null };
}
