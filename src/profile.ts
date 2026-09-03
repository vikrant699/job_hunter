import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { UserProfileSchema, SILENT_SCORE_FLOOR } from "./schemas.js";
import type { UserProfile } from "./types.js";
import { ensureResumeText } from "./tools/extractResume.js";

// Loads the user profile; see README "Setup". config/profile.ts and resume files are gitignored.

const here = dirname(fileURLToPath(import.meta.url));

// --profile <name> (or PROFILE env) selects config/profiles/<name>/; default falls back to config/profile.ts + config/resume.* with id "default".
function selectedProfileName(): string {
  const argv = process.argv;
  const i = argv.indexOf("--profile");
  const next = i >= 0 ? argv[i + 1] : undefined;
  const fromArg = next && !next.startsWith("--") ? next : undefined;
  return (fromArg ?? process.env.PROFILE ?? "default").trim();
}

const profileName = selectedProfileName();
const namedDir = resolve(here, `../config/profiles/${profileName}`);
const namedProfile = resolve(namedDir, "profile.ts");
const defaultProfile = resolve(here, "../config/profile.ts");
const examplePath = resolve(here, "../config/profile.example.ts");

// Abort if a named profile was requested but missing, rather than silently scoring the default resume under the requested profile_id.
if (profileName !== "default" && !existsSync(namedProfile)) {
  process.stderr.write(
    `[profile] --profile ${profileName} requested but config/profiles/${profileName}/profile.ts not found — aborting.\n`,
  );
  process.exit(1);
}

const useNamed = profileName !== "default";
const userPath = useNamed ? namedProfile : existsSync(defaultProfile) ? defaultProfile : examplePath;
const resumeDir = useNamed ? namedDir : resolve(here, "../config");
const usingExample = userPath === examplePath;

// matchThreshold at or below the silent floor collapses the yellow band (everything is either dropped or green); fail loudly at load time.
export function assertMatchThresholdAboveFloor(matchThreshold: number, silentFloor?: number): void {
  const floor = silentFloor ?? SILENT_SCORE_FLOOR;
  if (matchThreshold <= floor) {
    throw new Error(
      `[profile] filters.matchThreshold (${matchThreshold}) must be greater than ` +
        `the silent floor (${floor}) — otherwise the yellow band vanishes and every ` +
        "notification is green. Raise matchThreshold above the floor in your profile config.",
    );
  }
}

const ProfileModuleSchema = z.object({ profile: UserProfileSchema });
const mod = ProfileModuleSchema.parse(await import(pathToFileURL(userPath).href));
assertMatchThresholdAboveFloor(mod.profile.filters.matchThreshold, mod.profile.filters.silentFloor);

const resumeText = await ensureResumeText(resumeDir);
export const profile: UserProfile = { ...mod.profile, id: profileName, resumeText };

/** Absolute path to this profile's resume PDF. */
export const resumePdfPath: string = join(resumeDir, "resume.pdf");

if (usingExample) {
  // stderr: pino isn't configured yet, and npm scripts can swallow stdout.
  process.stderr.write(
    "[profile] using config/profile.example.ts — copy it to config/profile.ts and edit to make this your own.\n",
  );
}

export type { UserProfile } from "./types.js";
