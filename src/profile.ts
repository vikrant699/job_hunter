import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { UserProfile } from "../config/profile.example.js";
import { ensureResumeText } from "./tools/extract-resume.js";

/**
 * Loads the user profile from `config/profile.ts` if present, otherwise falls
 * back to the committed `config/profile.example.ts`, and attaches the resume the
 * relevance gate judges against.
 *
 * Setup for a new clone:
 *   cp config/profile.example.ts config/profile.ts
 *   <edit config/profile.ts to taste>
 *   put your resume at config/resume.pdf
 *
 * The resume comes from config/resume.txt, generated once from config/resume.pdf.
 * If neither exists the load throws and the bot stops. `config/profile.ts`,
 * `config/resume.pdf`, and `config/resume.txt` are gitignored.
 */

const here = dirname(fileURLToPath(import.meta.url));
const userPath = resolve(here, "../config/profile.ts");
const examplePath = resolve(here, "../config/profile.example.ts");

const target = existsSync(userPath) ? userPath : examplePath;
const usingExample = target === examplePath;

const mod = (await import(pathToFileURL(target).href)) as { profile: UserProfile };
const resumeText = await ensureResumeText();
export const profile: UserProfile = { ...mod.profile, resumeText };

if (usingExample) {
  // Logged before pino is fully configured — use stderr so it's visible even
  // when run via npm scripts that swallow stdout.
  process.stderr.write(
    "[profile] using config/profile.example.ts — copy it to config/profile.ts and edit to make this your own.\n",
  );
}

export type { UserProfile } from "../config/profile.example.js";
