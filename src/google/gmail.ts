// src/google/gmail.ts
import { z } from "zod";
import { googleFetchJson } from "./rest.js";
import type { RestDeps } from "./rest.js";
import { toBase64Url } from "./mime.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

const CreateDraftResponseSchema = z.object({
  id: z.string(),
  message: z.object({
    id: z.string(),
    threadId: z.string(),
  }),
});

const SearchMessagesResponseSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string() }))
    .default([]),
});

const MessageMetadataResponseSchema = z.object({
  snippet: z.string().default(""),
  internalDate: z.coerce.number(),
});

export interface CreatedDraft {
  draftId: string;
  messageId: string;
  threadId: string;
}

/** Create a Gmail draft from a fully-built RFC 5322 MIME message. */
export async function createDraft(profileId: string, mime: string, deps: RestDeps = {}): Promise<CreatedDraft> {
  const body = await googleFetchJson(
    profileId,
    `${BASE_URL}/drafts`,
    { method: "POST", body: { message: { raw: toBase64Url(mime) } } },
    deps,
  );
  const parsed = CreateDraftResponseSchema.parse(body);
  return { draftId: parsed.id, messageId: parsed.message.id, threadId: parsed.message.threadId };
}

/**
 * Check whether a draft still exists (the user may have deleted or sent it
 * from the Gmail UI). Distinguishes a 404 ("gone") from any other failure,
 * which callers must not silently swallow.
 */
export async function getDraft(profileId: string, draftId: string, deps: RestDeps = {}): Promise<"exists" | "gone"> {
  try {
    await googleFetchJson(profileId, `${BASE_URL}/drafts/${encodeURIComponent(draftId)}`, {}, deps);
    return "exists";
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return "gone";
    throw err;
  }
}

export interface MessageRef {
  id: string;
  threadId: string;
}

/** Search messages matching a Gmail search query (e.g. `from:` / `subject:`). */
export async function searchMessages(profileId: string, q: string, deps: RestDeps = {}): Promise<MessageRef[]> {
  const url = `${BASE_URL}/messages?q=${encodeURIComponent(q)}&maxResults=20`;
  const body = await googleFetchJson(profileId, url, {}, deps);
  return SearchMessagesResponseSchema.parse(body).messages;
}

export interface MessageMetadata {
  snippet: string;
  internalDate: number;
}

/** Fetch metadata (snippet + internalDate) for a single message. */
export async function getMessageMetadata(profileId: string, id: string, deps: RestDeps = {}): Promise<MessageMetadata> {
  const url = `${BASE_URL}/messages/${encodeURIComponent(id)}?format=metadata`;
  const body = await googleFetchJson(profileId, url, {}, deps);
  return MessageMetadataResponseSchema.parse(body);
}
