import { z } from "zod";
import { SeveritySchema } from "../schemas.js";
import { logger } from "../logger.js";

/** Shape of one bundled role inside an outreach row's `roles_json` column.
 *  Single source of truth — imported by both sheetSync.ts (sheet projection)
 *  and verify.ts (per-role undrafted rows on draft_discarded). */
export const RoleEntrySchema = z.object({
  title: z.string(),
  jobUrl: z.string(),
  severity: SeveritySchema,
  score: z.number().nullable(),
});
export type RoleEntry = z.infer<typeof RoleEntrySchema>;

export const RolesJsonSchema = z.array(RoleEntrySchema);

/** Parses an outreach row's `roles_json` column into its typed role list.
 *  Total: malformed JSON or a schema mismatch logs and returns [] so one
 *  corrupt row can't abort a whole sheet projection or verify pass. */
export function parseRoles(rolesJson: string): RoleEntry[] {
  try {
    return RolesJsonSchema.parse(JSON.parse(rolesJson));
  } catch (err) {
    logger.warn({ rolesJson: rolesJson.slice(0, 200), err: String(err).slice(0, 120) }, "roles_json unparseable - treating as no roles");
    return [];
  }
}
