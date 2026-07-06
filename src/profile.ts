import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { UserProfileSchema, SILENT_SCORE_FLOOR } from "./schemas.js";
import type { UserProfile } from "./types.js";
import { ensureResumeText } from "./tools/extract-resume.js";

// Loads the user profile; see README "Setup". config/profile.ts and resume files are gitignored.

const here = dirname(fileURLToPath(import.meta.url));

// --profile <name> (or PROFILE env) selects config/profiles/<name>/; default
// falls back to config/profile.ts + config/resume.* with id "default".
function selectedProfileName(): string {
  const argv = process.argv;
  const i = argv.indexOf("--profile");
  const fromArg = i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : undefined;
  return (fromArg ?? process.env.PROFILE ?? "default").trim();
}

const profileName = selectedProfileName();
const namedDir = resolve(here, `../config/profiles/${profileName}`);
const namedProfile = resolve(namedDir, "profile.ts");
const defaultProfile = resolve(here, "../config/profile.ts");
const examplePath = resolve(here, "../config/profile.example.ts");

// Refuse to mislabel data: if a named profile was explicitly requested but its
// config is missing, abort rather than silently scoring the DEFAULT resume and
// stamping every row with the requested profile_id.
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

// If matchThreshold sits at or below the silent floor, the yellow band vanishes:
// classifyVerdict silently drops everything below the floor, and everything that
// survives already clears matchThreshold — every notification comes out green and
// the borderline tier stops existing. Fail loudly at load time instead of quietly
// degrading the triage signal.
export function assertMatchThresholdAboveFloor(matchThreshold: number): void {
  if (matchThreshold <= SILENT_SCORE_FLOOR) {
    throw new Error(
      `[profile] filters.matchThreshold (${matchThreshold}) must be greater than ` +
        `SILENT_SCORE_FLOOR (${SILENT_SCORE_FLOOR}) — otherwise the yellow band vanishes and every ` +
        "notification is green. Raise matchThreshold above the floor in your profile config.",
    );
  }
}

const ProfileModuleSchema = z.object({ profile: UserProfileSchema });
const mod = ProfileModuleSchema.parse(await import(pathToFileURL(userPath).href));
assertMatchThresholdAboveFloor(mod.profile.filters.matchThreshold);

const resumeText = await ensureResumeText(resumeDir);
export const profile: UserProfile = { ...mod.profile, id: profileName, resumeText };

if (usingExample) {
  // Logged before pino is fully configured — use stderr so it's visible even
  // when run via npm scripts that swallow stdout.
  process.stderr.write(
    "[profile] using config/profile.example.ts — copy it to config/profile.ts and edit to make this your own.\n",
  );
}

export type { UserProfile } from "./types.js";
