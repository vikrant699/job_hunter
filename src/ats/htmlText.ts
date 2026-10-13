const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
};

export function decodeNumericEntities(s: string): string {
  const decode = (entity: string, cp: number): string =>
    Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : entity;
  return s
    .replace(/&#(\d+);/g, (m, d: string) => decode(m, Number(d)))
    .replace(/&#x([\da-f]+);/gi, (m, h: string) => decode(m, parseInt(h, 16)));
}

const ATTR_NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Decode HTML-attribute entity escaping in a single pass, so a double-escaped sequence decodes exactly one layer. */
export function decodeAttrEntities(s: string): string {
  return s.replace(
    /&(?:#(\d+)|#[xX]([\da-fA-F]+)|([a-zA-Z]+));/g,
    (m: string, dec?: string, hex?: string, name?: string): string => {
      if (dec !== undefined) return String.fromCodePoint(Number(dec));
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      return (name !== undefined ? ATTR_NAMED_ENTITIES[name] : undefined) ?? m;
    },
  );
}

// An escaped opening tag is evidence the whole payload is entity-escaped HTML, not text merely mentioning `&lt;`.
const ESCAPED_TAG_RE = /&lt;\s*\/?[a-z][a-z0-9-]*[\s/&>]/i;

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";

  let s = html;

  if (!/<[a-z!/]/i.test(s) && ESCAPED_TAG_RE.test(s)) {
    s = decodeAttrEntities(s);
  }

  s = s.replace(/<(script|style)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, "");

  s = s.replace(/<\/(p|div|li|h[1-6]|br|tr|td)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = s.replace(/<[^>]+>/g, "");

  for (const [k, v] of Object.entries(ENTITY_MAP)) {
    s = s.split(k).join(v);
  }

  s = decodeNumericEntities(s);

  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");

  return s.trim();
}
