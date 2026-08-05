// src/ats/jsonList.ts — factory for the "one-shot JSON board" adapter shape:
// a single GET/POST returns the full posting list in one response, no
// pagination. Generic over both the parsed response type R and the item
// type I, so every vendor keeps its own typed zod schema and normalize
// function; the factory only owns the fetch -> parse -> filter -> normalize
// -> dedupe plumbing shared by all of them.
import type { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";
import { atsFetchJson, parseOrThrow } from "./http.js";

export interface JsonListAdapterSpec<R, I> {
  provider: Provider;
  url: (c: AdapterCompany) => string;
  schema: z.ZodType<R>;
  items: (parsed: R) => I[];
  /** Optional pre-normalize filter (e.g. publish/active/status flags). */
  keep?: (item: I) => boolean;
  normalize: (c: AdapterCompany, item: I) => NormalizedPosting | null;
  /** Override the bot UA for vendors whose stack rejects it. */
  userAgent?: string;
}

export function makeJsonListAdapter<R, I>(spec: JsonListAdapterSpec<R, I>): AtsAdapter {
  return {
    provider: spec.provider,

    async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
      const raw = await atsFetchJson(spec.url(company), {
        provider: spec.provider,
        ...(spec.userAgent !== undefined ? { userAgent: spec.userAgent } : {}),
      });
      const parsed = parseOrThrow(spec.schema, raw, { provider: spec.provider, slug: company.slug });
      const seen = new Set<string>();
      const out: NormalizedPosting[] = [];
      for (const item of spec.items(parsed)) {
        if (spec.keep && !spec.keep(item)) continue;
        const p = spec.normalize(company, item);
        if (!p || seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      return out;
    },
  };
}
