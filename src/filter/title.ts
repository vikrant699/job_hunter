import { profile } from "../profile.js";

export interface TitleCheck {
  /** If true, skip this posting before any LLM/JD work. */
  skip: boolean;
  /** First-matching pattern source (for debug logs); null when accepted. */
  reason: string | null;
}

/** Cheap regex pre-filter between dedup and JD fetch; ambiguous titles pass through to the LLM gate. */
export function checkTitle(title: string | null): TitleCheck {
  if (!title || title.trim().length === 0) {
    return { skip: false, reason: null };
  }
  const t = title.trim();
  for (const re of profile.titleDenyPatterns) {
    if (re.test(t)) {
      return { skip: true, reason: re.source };
    }
  }
  return { skip: false, reason: null };
}
