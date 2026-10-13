import { logger } from "../logger.js";

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
