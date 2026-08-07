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

/**
 * All Drive endpoints return only a DEFAULT field set (id, name, mimeType, kind)
 * unless `fields` asks for more - so the upload response carries no modifiedTime or
 * size, and parsing it as a full FileMeta would fail on the first real push. The id
 * is all we take from it; the metadata the sync actually needs is read back
 * explicitly below.
 */
const UploadedIdSchema = z.object({ id: z.string() });

const META_FIELDS = "id,name,size,modifiedTime";

/**
 * Google reports "the Drive API is switched off for this project" as a 403 whose
 * body carries the console URL that fixes it — about 250 characters in, i.e. past
 * the snippet limit. Worth pulling out by hand: it is a one-time setup step that is
 * easy to mistake for the permission problem it is NOT (consent grants the scope;
 * enabling the API is a separate switch), and the answer is a single link.
 */
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
  const url = `${DRIVE_FILES}?q=${q}&fields=${encodeURIComponent(`files(${META_FIELDS})`)}&orderBy=modifiedTime desc`;
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
  const { id } = UploadedIdSchema.parse(await putRes.json());
  // db/sync.ts stamps the local file with the returned modifiedTime, so it has to
  // be Drive's authoritative value — read it back rather than inferred from a
  // response whose field set we do not control.
  return getFileMeta(profileId, id, deps);
}

/** Full metadata for one file, with `fields` asked for explicitly. */
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
