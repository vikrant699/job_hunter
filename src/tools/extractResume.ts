// Imported by src/profile.ts at startup (ensureResumeText) - runtime code with a CLI entry, not a dev tool.
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDir = resolve(here, "../../config");
function paths(baseDir: string): { pdf: string; txt: string } {
  return { pdf: resolve(baseDir, "resume.pdf"), txt: resolve(baseDir, "resume.txt") };
}

/** Collapses PDF-extraction whitespace noise: normalized newlines, squeezed spaces/tabs, no blank-line runs. Idempotent. */
export function normalizeResumeText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out.join("\n").trim() + "\n";
}

/** Extracts config/resume.pdf -> normalized text, writes config/resume.txt, returns it; unpdf is imported lazily to skip the load when resume.txt is already cached. */
export async function extractResume(baseDir: string = defaultDir): Promise<string> {
  const { pdf: pdfPath, txt: txtPath } = paths(baseDir);
  if (!existsSync(pdfPath)) {
    throw new Error("config/resume.pdf not found - add your resume PDF at config/resume.pdf");
  }
  const { extractText, getDocumentProxy } = await import("unpdf");
  const buf = new Uint8Array(readFileSync(pdfPath));
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = text;
  const normalized = normalizeResumeText(merged);
  writeFileSync(txtPath, normalized, "utf-8");
  return normalized;
}

/** True when resume.txt is missing or older than resume.pdf; a txt with no pdf beside it is NOT stale. */
export function isResumeTextStale(baseDir: string = defaultDir): boolean {
  const { pdf: pdfPath, txt: txtPath } = paths(baseDir);
  if (!existsSync(txtPath)) return true;
  if (!existsSync(pdfPath)) return false;
  return statSync(pdfPath).mtimeMs > statSync(txtPath).mtimeMs;
}

/** The candidate resume text the relevance gate judges against: cached resume.txt when current, else regenerated from resume.pdf. Throws if neither exists. */
export async function ensureResumeText(baseDir: string = defaultDir): Promise<string> {
  if (!isResumeTextStale(baseDir)) return readFileSync(paths(baseDir).txt, "utf-8");
  return extractResume(baseDir);
}

/** CLI dir selection: `--profile <name>` targets config/profiles/<name>/, otherwise the default config/ dir. */
export function resolveCliBaseDir(argv: readonly string[]): string {
  const i = argv.indexOf("--profile");
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (name && !name.startsWith("--")) return resolve(here, `../../config/profiles/${name}`);
  return defaultDir;
}

// `npm run extract-resume [-- --profile <name>]` forces a fresh extraction (e.g. after the PDF changes).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = resolveCliBaseDir(process.argv);
  extractResume(dir)
    .then((t) => console.log(`extracted ${t.length} chars → ${resolve(dir, "resume.txt")}`))
    .catch((e) => { console.error(`extract-resume failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
