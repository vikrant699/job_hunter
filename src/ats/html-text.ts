// Cheap HTML → plain text. Adequate for the simple, well-formed HTML the
// ATSes return. Anything weird should go through cheerio.
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

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";

  let s = html;

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
  s = s.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
  s = s.replace(/&#x([\da-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");

  return s.trim();
}
