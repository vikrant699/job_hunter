import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDir = resolve(here, "../../config");
function paths(baseDir: string): { pdf: string; txt: string } {
  return { pdf: resolve(baseDir, "resume.pdf"), txt: resolve(baseDir, "resume.txt") };
}

export function normalizeResumeText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out.join("\n").trim() + "\n";
}

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

export function isResumeTextStale(baseDir: string = defaultDir): boolean {
  const { pdf: pdfPath, txt: txtPath } = paths(baseDir);
  if (!existsSync(txtPath)) return true;
  if (!existsSync(pdfPath)) return false;
  return statSync(pdfPath).mtimeMs > statSync(txtPath).mtimeMs;
}

export async function ensureResumeText(baseDir: string = defaultDir): Promise<string> {
  if (!isResumeTextStale(baseDir)) return readFileSync(paths(baseDir).txt, "utf-8");
  return extractResume(baseDir);
}

export function resolveCliBaseDir(argv: readonly string[]): string {
  const i = argv.indexOf("--profile");
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (name && !name.startsWith("--")) return resolve(here, `../../config/profiles/${name}`);
  return defaultDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = resolveCliBaseDir(process.argv);
  extractResume(dir)
    .then((t) => console.log(`extracted ${t.length} chars → ${resolve(dir, "resume.txt")}`))
    .catch((e) => { console.error(`extract-resume failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
