// Cheap HTML -> plain text, adequate for the simple, well-formed HTML the ATSes return. Anything weird should go through cheerio.
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

/** Decode both numeric entity forms (&#123; / &#x1F600;); malformed/out-of-range entities pass through. */
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

  // Some vendors ship the JD fully entity-escaped; if there are no raw tags but escaped ones exist, decode one layer first so the strip pass sees real markup.
  if (!/<[a-z!/]/i.test(s) && ESCAPED_TAG_RE.test(s)) {
    s = decodeAttrEntities(s);
  }

  // Drop <script>/<style> blocks entirely.
  s = s.replace(/<(script|style)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, "");

  // Convert block-level closing tags to newlines so paragraphs/lists stay separated.
  s = s.replace(/<\/(p|div|li|h[1-6]|br|tr|td)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, "");

  // Decode named entities (limited set above).
  for (const [k, v] of Object.entries(ENTITY_MAP)) {
    s = s.split(k).join(v);
  }

  // Decode numeric entities.
  s = decodeNumericEntities(s);

  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");

  return s.trim();
}
