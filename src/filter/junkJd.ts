const PLACEHOLDER_RES: readonly RegExp[] = [
  /^please (enter|update) (the )?job description\.?$/i,
  /^(job )?description( goes)? here\.?$/i,
  /^(tbd|tba|na|n\/a)\.?$/i,
  /^attached\.?$/i, // PDF-only JD, text not visible
  /^(lorem ipsum)\b/i,
  /^sample data\.?$/i,
];

export function isJunkJd(jdText: string): boolean {
  const t = jdText.trim();
  if (t === "") return false;
  if (!/[a-z0-9]/i.test(t)) return true;
  return PLACEHOLDER_RES.some((re) => re.test(t));
}
