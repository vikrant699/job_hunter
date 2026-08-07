// src/google/drive.ts - minimal Drive client for syncing the SQLite file
// between machines. Reuses getAccessToken from auth.ts (same OAuth client and
// per-profile refresh token as Gmail/Sheets); the only extra requirement is the
// drive.file scope, which grants access to app-created files ONLY.
//
// googleFetchJson can't serve here: it JSON-encodes the body and always parses a
// JSON response, whereas these calls move ~50 MB of binary. The bearer-token and
// error-shaping conventions are kept identical.
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getAccessToken } from "./auth.js";
import type { GoogleAuthDeps } from "./auth.js";

export interface DriveDeps {
  fetchFn?: typeof fetch;
  authDeps?: GoogleAuthDeps;
}

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const FileMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string().optional(),
  modifiedTime: z.string(),
});
export type DriveFileMeta = z.infer<typeof FileMetaSchema>;

const FileListSchema = z.object({ files: z.array(FileMetaSchema).default([]) });

function driveError(what: string, status: number, body: string): Error {
  return new Error(`Drive ${what} failed (HTTP ${status}): ${body.slice(0, 200)}`);
}

async function authHeader(profileId: string, deps: DriveDeps): Promise<string> {
  return `Bearer ${await getAccessToken(profileId, deps.authDeps)}`;
}

/**
 * Look up the backup by name. Returns null when it does not exist yet (first
 * ever push). With drive.file scope this search can only ever match a file this
 * app created, so a plain name query is safe and needs no stored file id.
 */
export async function findDbFile(
  profileId: string,
  deps: DriveDeps = {},
): Promise<DriveFileMeta | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const q = encodeURIComponent(`name = '${config.google.driveDbFileName}' and trashed = false`);
  const url = `${DRIVE_FILES}?q=${q}&fields=${encodeURIComponent("files(id,name,size,modifiedTime)")}&orderBy=modifiedTime desc`;
  const res = await fetchFn(url, { headers: { Authorization: await authHeader(profileId, deps) } });
  if (!res.ok) throw driveError("lookup", res.status, await res.text());
  const list = FileListSchema.parse(await res.json());
  return list.files[0] ?? null;
}

/**
 * Create-or-replace the backup using a resumable upload. Drive's simple and
 * multipart uploads cap at 5 MB, and the DB is ~50 MB, so resumable is the only
 * option - but the payload still goes in a single PUT, so it is two round trips,
 * not a chunking loop.
 */
export async function uploadDbFile(
  profileId: string,
  bytes: Uint8Array,
  existingFileId: string | null,
  deps: DriveDeps = {},
): Promise<DriveFileMeta> {
  const fetchFn = deps.fetchFn ?? fetch;
  const auth = await authHeader(profileId, deps);
  const isUpdate = existingFileId !== null;
  const initUrl = isUpdate
    ? `${DRIVE_UPLOAD}/${existingFileId}?uploadType=resumable`
    : `${DRIVE_UPLOAD}?uploadType=resumable`;

  const initRes = await fetchFn(initUrl, {
    method: isUpdate ? "PATCH" : "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(bytes.byteLength),
    },
    // Name is only settable on create; a PATCH keeps the existing name.
    body: JSON.stringify(isUpdate ? {} : { name: config.google.driveDbFileName }),
  });
  if (!initRes.ok) throw driveError("upload-init", initRes.status, await initRes.text());

  const sessionUrl = initRes.headers.get("location");
  if (sessionUrl === null || sessionUrl === "") {
    throw new Error("Drive upload-init returned no resumable session URL");
  }

  const putRes = await fetchFn(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) },
    body: bytes,
  });
  if (!putRes.ok) throw driveError("upload", putRes.status, await putRes.text());
  return FileMetaSchema.parse(await putRes.json());
}

/** Download the backup's bytes. */
export async function downloadDbFile(
  profileId: string,
  fileId: string,
  deps: DriveDeps = {},
): Promise<Uint8Array> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${DRIVE_FILES}/${fileId}?alt=media`, {
    headers: { Authorization: await authHeader(profileId, deps) },
  });
  if (!res.ok) throw driveError("download", res.status, await res.text());
  const buf = await res.arrayBuffer();
  logger.debug({ bytes: buf.byteLength }, "drive: downloaded db file");
  return new Uint8Array(buf);
}
