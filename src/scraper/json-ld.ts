import * as cheerio from "cheerio";
import { JsonValueSchema, type JsonValue } from "../util/json.js";

export interface JsonLdJob {
  title: string;
  url: string | null;
  /** Flattened "City, Region, Country; City2..." string; "Remote" appended for TELECOMMUTE. */
  location: string | null;
  datePosted: string | null;
  /** Raw description (may be HTML — callers run it through htmlToText). */
  description: string | null;
}

function isObj(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// schema.org allows "@type": "JobPosting" or "@type": ["JobPosting", ...].
function typeIncludes(v: JsonValue | undefined, want: string): boolean {
  if (typeof v === "string") return v === want;
  if (Array.isArray(v)) return v.some((t) => t === want);
  return false;
}

function str(v: JsonValue | undefined): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function locationOf(node: { [k: string]: JsonValue }): string | null {
  const parts: string[] = [];
  const raw = node["jobLocation"];
  const locs = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  for (const l of locs) {
    if (!isObj(l)) continue;
    const addr = l["address"];
    if (isObj(addr)) {
      const country = addr["addressCountry"];
      const countryName = isObj(country) ? str(country["name"]) : str(country);
      const seg = [str(addr["addressLocality"]), str(addr["addressRegion"]), countryName]
        .filter((s): s is string => s !== null)
        .join(", ");
      if (seg) parts.push(seg);
    } else {
      const name = str(l["name"]); // bare Place with just a name
      if (name) parts.push(name);
    }
  }
  if (typeIncludes(node["jobLocationType"], "TELECOMMUTE")) parts.push("Remote");
  return parts.length > 0 ? parts.join("; ") : null;
}

function collect(v: JsonValue, out: JsonLdJob[]): void {
  if (Array.isArray(v)) {
    for (const item of v) collect(item, out);
    return;
  }
  if (!isObj(v)) return;
  if (typeIncludes(v["@type"], "JobPosting")) {
    const title = str(v["title"]);
    if (title) {
      out.push({
        title,
        url: str(v["url"]),
        location: locationOf(v),
        datePosted: str(v["datePosted"]),
        description: str(v["description"]),
      });
    }
  }
  // Containers that commonly wrap JobPosting nodes.
  for (const key of ["@graph", "itemListElement", "item", "mainEntity", "mainEntityOfPage"]) {
    const child = v[key];
    if (child !== undefined) collect(child, out);
  }
}

/** Every schema.org JobPosting embedded in the page's JSON-LD blocks. */
export function extractJsonLdJobs(html: string): JsonLdJob[] {
  const $ = cheerio.load(html);
  const out: JsonLdJob[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 2_000_000) return;
    let parsed: JsonValue;
    try {
      parsed = JsonValueSchema.parse(JSON.parse(raw));
    } catch {
      return; // malformed block — skip, never throw
    }
    collect(parsed, out);
  });
  // Pages sometimes repeat the same block (SSR + hydration) — dedup.
  const seen = new Set<string>();
  return out.filter((j) => {
    const k = `${j.title}|${j.url ?? ""}|${j.location ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
