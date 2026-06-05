import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { UserProfile } from "../config/profile.example.js";

/**
 * Loads the user profile from `config/profile.ts` if present, otherwise falls
 * back to the committed `config/profile.example.ts`.
 *
 * Setup for a new clone:
 *   cp config/profile.example.ts config/profile.ts
 *   <edit config/profile.ts to taste>
 *
 * `config/profile.ts` is gitignored.
 */

const here = dirname(fileURLToPath(import.meta.url));
const userPath = resolve(here, "../config/profile.ts");
const examplePath = resolve(here, "../config/profile.example.ts");

const target = existsSync(userPath) ? userPath : examplePath;
const usingExample = target === examplePath;

const mod = (await import(pathToFileURL(target).href)) as { profile: UserProfile };
const resumeTextPath = resolve(here, "../config/resume.txt");
const resumeText = existsSync(resumeTextPath) ? readFileSync(resumeTextPath, "utf-8") : undefined;
export const profile: UserProfile = resumeText ? { ...mod.profile, resumeText } : mod.profile;

if (usingExample) {
  // Logged before pino is fully configured — use stderr so it's visible even
  // when run via npm scripts that swallow stdout.
  process.stderr.write(
    "[profile] using config/profile.example.ts — copy it to config/profile.ts and edit to make this your own.\n",
  );
}

export type { UserProfile } from "../config/profile.example.js";
