import { logger } from "../logger.js";

/** Everything a prompt template placeholder may be filled with: renders to
 *  "" for null/undefined, one "- item" line per array entry, else String(value). */
export type PromptVar = string | number | boolean | null | undefined | readonly string[];

export function render(template: string, vars: Record<string, PromptVar>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      logger.warn({ key }, "render: template placeholder has no matching variable");
      return "";
    }
    const value = vars[key];
    if (value == null) return "";
    if (Array.isArray(value)) {
      return value.map((item) => `- ${String(item)}`).join("\n");
    }
    return String(value);
  });
}
