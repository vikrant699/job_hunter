import { profile } from "../profile.js";

/**
 * Cheap pre-filter: is this company on the user's services/staffing denylist?
 * Returning true is a hard deny — the LLM gate is never invoked for the company.
 */
export function isDeniedCompany(name: string, slug: string): { denied: boolean; reason: string | null } {
  const slugLc = slug.toLowerCase();
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
