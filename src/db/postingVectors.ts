// Shadow-mode embedding storage (src/llm/embed.ts): one row per (posting, profile, model_tag).
// Never read by filtering/verdict logic — a later, owner-gated task may use these.
import { z } from "zod";
import type { Provider } from "../schemas.js";
import { ProviderSchema } from "../schemas.js";
import { db, queryOne } from "./db.js";

/** Float32 vector -> BLOB. A Float32Array's own buffer is exactly its bytes when built with `.from`
 *  (no slack from a larger backing ArrayBuffer), but byteOffset/byteLength are still read explicitly
 *  so the Buffer view is correct even if that ever stops being true. */
export function floatsToBlob(vector: number[]): Buffer {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/** BLOB -> float32 vector, the inverse of floatsToBlob. */
export function blobToFloats(blob: Uint8Array): number[] {
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(floats);
}

export interface PostingVectorUpsert {
  provider: Provider;
  externalId: string;
  profileId: string;
  modelTag: string;
  vector: number[];
}

export interface PostingVectorRow {
  dims: number;
  vector: number[];
  createdAt: string;
}

const upsertPostingVectorStmt = db.prepare(`
  INSERT INTO posting_vectors (provider, external_id, profile_id, model_tag, dims, vec, created_at)
  VALUES (:provider, :externalId, :profileId, :modelTag, :dims, :vec, :createdAt)
  ON CONFLICT(provider, external_id, profile_id, model_tag) DO UPDATE SET
    dims       = excluded.dims,
    vec        = excluded.vec,
    created_at = excluded.created_at
`);

export function upsertPostingVector(row: PostingVectorUpsert): void {
  upsertPostingVectorStmt.run({
    provider: row.provider,
    externalId: row.externalId,
    profileId: row.profileId,
    modelTag: row.modelTag,
    dims: row.vector.length,
    vec: floatsToBlob(row.vector),
    createdAt: new Date().toISOString(),
  });
}

const PostingVectorRowSchema = z.object({
  provider: ProviderSchema,
  external_id: z.string(),
  profile_id: z.string(),
  model_tag: z.string(),
  dims: z.number(),
  vec: z.instanceof(Uint8Array),
  created_at: z.string(),
});

const selectPostingVectorStmt = db.prepare(`
  SELECT provider, external_id, profile_id, model_tag, dims, vec, created_at
  FROM posting_vectors
  WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId AND model_tag = :modelTag
`);

export function getPostingVector(
  provider: Provider,
  externalId: string,
  profileId: string,
  modelTag: string,
): PostingVectorRow | undefined {
  const row = queryOne(selectPostingVectorStmt, PostingVectorRowSchema, {
    provider,
    externalId,
    profileId,
    modelTag,
  });
  if (!row) return undefined;
  return { dims: row.dims, vector: blobToFloats(row.vec), createdAt: row.created_at };
}
