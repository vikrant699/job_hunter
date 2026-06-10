import { logger } from "../logger.js";

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      // A template edited without updating its caller would otherwise silently
      // substitute "" and quietly degrade the prompt.
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
