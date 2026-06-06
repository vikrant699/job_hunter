import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pdfPath = resolve(here, "../../config/resume.pdf");
const txtPath = resolve(here, "../../config/resume.txt");

/** Collapse PDF-extraction whitespace noise: normalize newlines, squeeze runs of
 *  spaces/tabs, trim each line, drop consecutive blank lines, trim ends. Idempotent. */
export function normalizeResumeText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out.join("\n").trim() + "\n";
}

/** Extract config/resume.pdf -> normalized text, write config/resume.txt, return it.
 *  Throws if config/resume.pdf is absent. (unpdf imported lazily so it is not loaded
 *  on the hot path when config/resume.txt is already cached.) */
export async function extractResume(): Promise<string> {
  if (!existsSync(pdfPath)) {
    throw new Error("config/resume.pdf not found - add your resume PDF at config/resume.pdf");
  }
  const { extractText, getDocumentProxy } = await import("unpdf");
  const buf = new Uint8Array(readFileSync(pdfPath));
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = typeof text === "string" ? text : (text as string[]).join("\n");
  const normalized = normalizeResumeText(merged);
  writeFileSync(txtPath, normalized, "utf-8");
  return normalized;
}

/** The candidate resume text the relevance gate judges against: the cached
 *  config/resume.txt if present, else generated once from config/resume.pdf.
 *  Throws if neither exists - the bot must stop, there is nothing to match on. */
export async function ensureResumeText(): Promise<string> {
  if (existsSync(txtPath)) return readFileSync(txtPath, "utf-8");
  return extractResume();
}

// `npm run extract-resume` forces a fresh extraction (e.g. after the PDF changes).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  extractResume()
    .then((t) => console.log(`extracted ${t.length} chars → config/resume.txt`))
    .catch((e) => { console.error(`extract-resume failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
