/** First (or n-th) capture group of `re` in `text`, or null when the regex
 *  doesn't match or the group didn't participate. Replaces the
 *  `const m = re.exec(s); return m ? m[1]! : null;` idiom without the `!`. */
export function matchGroup(re: RegExp, text: string, group = 1): string | null {
  const m = re.exec(text);
  return m?.[group] ?? null;
}
