import { profile } from "../profile.js";

export interface TitleCheck {
  skip: boolean;
  reason: string | null;
}

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
