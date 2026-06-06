import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { UserProfileSchema } from "./schemas.js";
import type { UserProfile } from "./types.js";
import { ensureResumeText } from "./tools/extract-resume.js";

// Loads the user profile; see README "Setup". config/profile.ts and resume files are gitignored.

const here = dirname(fileURLToPath(import.meta.url));
const userPath = resolve(here, "../config/profile.ts");
const examplePath = resolve(here, "../config/profile.example.ts");

const target = existsSync(userPath) ? userPath : examplePath;
const usingExample = target === examplePath;

const ProfileModuleSchema = z.object({ profile: UserProfileSchema });
const mod = ProfileModuleSchema.parse(await import(pathToFileURL(target).href));
const resumeText = await ensureResumeText();
export const profile: UserProfile = { ...mod.profile, resumeText };

if (usingExample) {
  // Logged before pino is fully configured — use stderr so it's visible even
  // when run via npm scripts that swallow stdout.
  process.stderr.write(
    "[profile] using config/profile.example.ts — copy it to config/profile.ts and edit to make this your own.\n",
  );
}

export type { UserProfile } from "./types.js";
