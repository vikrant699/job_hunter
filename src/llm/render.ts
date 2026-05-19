export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = vars[key];
    if (value == null) return "";
    if (Array.isArray(value)) {
      return value.map((item) => `- ${String(item)}`).join("\n");
    }
    return String(value);
  });
}
