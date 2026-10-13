import { z } from "zod";
import { SeveritySchema } from "../schemas.js";
import { logger } from "../logger.js";

export const RoleEntrySchema = z.object({
  title: z.string(),
  jobUrl: z.string(),
  severity: SeveritySchema,
  score: z.number().nullable(),
});
export type RoleEntry = z.infer<typeof RoleEntrySchema>;

export const RolesJsonSchema = z.array(RoleEntrySchema);

export function parseRoles(rolesJson: string): RoleEntry[] {
  try {
    return RolesJsonSchema.parse(JSON.parse(rolesJson));
  } catch (err) {
    logger.warn({ rolesJson: rolesJson.slice(0, 200), err: String(err).slice(0, 120) }, "roles_json unparseable - treating as no roles");
    return [];
  }
}
