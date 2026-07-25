import { ApiMetaSchema } from "../schemas.js";

/** Parse the api_meta JSON column into a token map, or null. */
export function parseApiMeta(s: string | null): Record<string, string> | null {
  if (!s) return null;
  try {
    const o: unknown = JSON.parse(s);
    const result = ApiMetaSchema.safeParse(o);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
