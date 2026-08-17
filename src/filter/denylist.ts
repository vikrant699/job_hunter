import { profile } from "../profile.js";
import { NOISE_DENYLIST_SLUGS, isNoiseSlug } from "./noiseDenylist.js";

/** Hard deny (LLM gate never invoked) if on the services/staffing denylist or the confirmed-noise denylist. */
export function isDeniedCompany(name: string, slug: string): { denied: boolean; reason: string | null } {
  const slugLc = slug.toLowerCase();

  if (isNoiseSlug(slugLc)) {
    return { denied: true, reason: `noise:${NOISE_DENYLIST_SLUGS[slugLc]}` };
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
