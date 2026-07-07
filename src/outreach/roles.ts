import { z } from "zod";
import { SeveritySchema } from "../schemas.js";

/** Shape of one bundled role inside an outreach row's `roles_json` column.
 *  Single source of truth — imported by both sheet-sync.ts (sheet projection)
 *  and verify.ts (per-role undrafted rows on draft_discarded). */
export const RoleEntrySchema = z.object({
  title: z.string(),
  jobUrl: z.string(),
  severity: SeveritySchema,
  score: z.number().nullable(),
});
export type RoleEntry = z.infer<typeof RoleEntrySchema>;

export const RolesJsonSchema = z.array(RoleEntrySchema);

/** Parses an outreach row's `roles_json` column into its typed role list. */
export function parseRoles(rolesJson: string): RoleEntry[] {
  return RolesJsonSchema.parse(JSON.parse(rolesJson));
}
