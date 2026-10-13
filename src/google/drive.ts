// Doesn't reuse googleFetchJson: it always JSON-encodes/parses and these calls move ~50 MB of binary.
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

// Drive returns only default fields, so the upload response lacks modifiedTime/size; they are read back explicitly.
const UploadedIdSchema = z.object({ id: z.string() });

const META_FIELDS = "id,name,size,modifiedTime";

// "API disabled" 403s carry the fix URL past the snippet slice limit, so it's extracted by hand.
const API_DISABLED_RE = /has not been used in project|accessNotConfigured|it is disabled/i;

function driveError(what: string, status: number, body: string): Error {
  if (API_DISABLED_RE.test(body)) {
    const project = /project (\d+)/.exec(body)?.[1];
    const link = `https://console.cloud.google.com/apis/library/drive.googleapis.com${project === undefined ? "" : `?project=${project}`}`;
    return new Error(
      `Drive ${what} failed (HTTP ${status}): the Google Drive API is not enabled for this ` +
        `OAuth project${project === undefined ? "" : ` (${project})`}. Enable it at ${link}, wait a minute, then retry. ` +
        `Note this is separate from consent — the drive.file scope can be granted while the API itself is still off.`,
    );
  }
  return new Error(`Drive ${what} failed (HTTP ${status}): ${body.slice(0, 200)}`);
}

async function authHeader(profileId: string, deps: DriveDeps): Promise<string> {
  return `Bearer ${await getAccessToken(profileId, deps.authDeps)}`;
}

export async function findDbFile(
  profileId: string,
  deps: DriveDeps = {},
): Promise<DriveFileMeta | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const q = encodeURIComponent(`name = '${config.google.driveDbFileName}' and trashed = false`);
  const url = `${DRIVE_FILES}?q=${q}&fields=${encodeURIComponent(`files(${META_FIELDS})`)}&orderBy=modifiedTime desc`;
  const res = await fetchFn(url, { headers: { Authorization: await authHeader(profileId, deps) } });
  if (!res.ok) throw driveError("lookup", res.status, await res.text());
  const list = FileListSchema.parse(await res.json());
  return list.files[0] ?? null;
}

/** Resumable upload: simple/multipart cap at 5MB, the DB is ~50MB. */
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
  const { id } = UploadedIdSchema.parse(await putRes.json());
  // db/sync.ts needs Drive's authoritative modifiedTime.
  return getFileMeta(profileId, id, deps);
}

export async function getFileMeta(
  profileId: string,
  fileId: string,
  deps: DriveDeps = {},
): Promise<DriveFileMeta> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${DRIVE_FILES}/${fileId}?fields=${encodeURIComponent(META_FIELDS)}`, {
    headers: { Authorization: await authHeader(profileId, deps) },
  });
  if (!res.ok) throw driveError("metadata", res.status, await res.text());
  return FileMetaSchema.parse(await res.json());
}

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
