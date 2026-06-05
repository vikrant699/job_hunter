import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";

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

async function main(): Promise<void> {
  if (!existsSync(pdfPath)) {
    console.error("config/resume.pdf not found — drop your resume PDF there first.");
    process.exit(1);
  }
  const buf = new Uint8Array(readFileSync(pdfPath));
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = typeof text === "string" ? text : (text as string[]).join("\n");
  const normalized = normalizeResumeText(merged);
  writeFileSync(txtPath, normalized, "utf-8");
  console.log(`extracted ${normalized.length} chars → config/resume.txt`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(`extract-resume failed: ${e}`); process.exit(1); });
}
