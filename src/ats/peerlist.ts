// src/ats/peerlist.ts — Peerlist-hosted career boards (careers.peerlist.io), a server-rendered
// Next.js page whose `<script id="__NEXT_DATA__">` island carries props.pageProps.careersList
// (board postings) and jobData (populated only on a single job's own page). No live board has ever
// had postings to observe, so the per-item schema is deliberately tolerant: multiple candidate keys
// for id/title/location, and .passthrough() for unknown fields.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, joinLocation } from "./shared.js";
import { kebabCase } from "../util/slug.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

export const PEERLIST_ORIGIN = "https://careers.peerlist.io";
export const PEERLIST_BOARD_URL = `${PEERLIST_ORIGIN}/`;

const LooseLocationPartSchema = z.object({
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export const PeerlistJobLikeSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    jobId: z.union([z.string(), z.number()]).nullable().optional(),
    slug: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    location: z.union([z.string(), LooseLocationPartSchema, z.array(LooseLocationPartSchema)]).nullable().optional(),
    description: z.string().nullable().optional(),
    jobDescription: z.string().nullable().optional(),
  })
  .passthrough();
export type PeerlistJobLike = z.infer<typeof PeerlistJobLikeSchema>;

const PagePropsSchema = z
  .object({
    careersList: z.array(PeerlistJobLikeSchema).nullable().optional(),
    jobData: PeerlistJobLikeSchema.nullable().optional(),
  })
  .passthrough();

const NextDataSchema = z.object({
  props: z.object({ pageProps: PagePropsSchema }),
});

export function extractPeerlistNextData(html: string): JsonValue | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  return tryParseJson(m[1] ?? "");
}

export interface PeerlistPageProps {
  careersList: PeerlistJobLike[];
  jobData: PeerlistJobLike | null;
}

export function parsePeerlistPageProps(nextData: JsonValue, slug: string): PeerlistPageProps {
  const parsed = parseOrThrow(NextDataSchema, nextData, { provider: "peerlist", slug, what: "__NEXT_DATA__" });
  return {
    careersList: parsed.props.pageProps.careersList ?? [],
    jobData: parsed.props.pageProps.jobData ?? null,
  };
}

export function peerlistItemTitle(item: PeerlistJobLike): string {
  return item.title ?? item.role ?? item.jobTitle ?? "";
}

// Stable identity: explicit id, then jobId, then slug, then a slugified title as a last resort.
export function peerlistExternalId(item: PeerlistJobLike): string {
  if (item.id != null) return String(item.id);
  if (item.jobId != null) return String(item.jobId);
  if (item.slug) return item.slug;
  return kebabCase(peerlistItemTitle(item));
}

function peerlistSlugOrId(item: PeerlistJobLike): string | null {
  if (item.slug) return item.slug;
  if (item.id != null) return String(item.id);
  if (item.jobId != null) return String(item.jobId);
  return null;
}

export function peerlistJobUrl(item: PeerlistJobLike): string {
  const slugOrId = peerlistSlugOrId(item);
  return slugOrId ? `${PEERLIST_ORIGIN}/${slugOrId}` : PEERLIST_BOARD_URL;
}

function oneLocationPart(l: z.infer<typeof LooseLocationPartSchema>): string {
  return joinLocation(l.city, l.country) ?? "";
}

export function peerlistLocationText(loc: PeerlistJobLike["location"]): string | null {
  if (loc == null) return null;
  if (typeof loc === "string") return loc.trim() || null;
  if (Array.isArray(loc)) {
    const joined = loc.map(oneLocationPart).filter((s) => s.length > 0).join("; ");
    return joined || null;
  }
  const s = oneLocationPart(loc);
  return s || null;
}

export function peerlistDescriptionHtml(item: PeerlistJobLike): string {
  return item.description ?? item.jobDescription ?? "";
}

export function normalizePeerlistItem(company: AdapterCompany, item: PeerlistJobLike): NormalizedPosting {
  const location = peerlistLocationText(item.location);
  return {
    provider: "peerlist",
    externalId: peerlistExternalId(item),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: peerlistItemTitle(item) || "Untitled",
    jobUrl: peerlistJobUrl(item),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(peerlistDescriptionHtml(item)),
    postedAt: null,
  };
}

export const peerlistAdapter: AtsAdapter = {
  provider: "peerlist",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = company.careersUrl || PEERLIST_BOARD_URL;
    const html = await atsFetchText(url, { provider: "peerlist" });
    const nextData = extractPeerlistNextData(html);
    if (!nextData) throw new Error(`peerlist: no __NEXT_DATA__ island for ${company.slug}`);
    const { careersList } = parsePeerlistPageProps(nextData, company.slug);
    return careersList.map((item) => normalizePeerlistItem(company, item));
  },
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "peerlist" });
    const nextData = extractPeerlistNextData(html);
    if (!nextData) return "";
    const { jobData } = parsePeerlistPageProps(nextData, company.slug);
    if (!jobData) return "";
    return htmlToText(peerlistDescriptionHtml(jobData));
  },
};
