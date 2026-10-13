export function matchGroup(re: RegExp, text: string, group = 1): string | null {
  const m = re.exec(text);
  return m?.[group] ?? null;
}
