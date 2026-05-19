/**
 * Slug-probe utility.
 *
 * Usage:
 *   npm run probe -- razorpay
 *   npm run probe -- razorpay swiggy meesho
 *
 * For each candidate company name, tries plausible slugs against every supported
 * ATS and reports the first hit. Used during seed compilation to classify names
 * into ats-api vs llm-scrape strategies.
 */
import { config } from "../config.js";

const PROBES: Array<{ provider: string; url: (slug: string) => string }> = [
  {
    provider: "greenhouse",
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=false`,
  },
  {
    provider: "lever",
    url: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  },
  {
    provider: "ashby",
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=false`,
  },
];

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return false;
      // Validate response body looks right — some boards return 200 with empty/redirect.
      const text = await res.text();
      if (text.length < 10) return false;
      // Quick sniff for a real job board response (avoid HTML error pages).
      const lc = text.slice(0, 200).toLowerCase();
      if (lc.includes("<!doctype") || lc.includes("<html")) return false;
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function slugVariants(name: string): string[] {
  const base = name.toLowerCase().trim();
  const kebab = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const flat = base.replace(/[^a-z0-9]/g, "");
  const noSuffix = kebab.replace(/-?(inc|llc|ltd|pvt|private|limited|technologies|tech|labs|india)$/i, "");
  const noPrefix = kebab.replace(/^(the-)/i, "");
  const variants = new Set([kebab, flat, noSuffix, noPrefix]);
  return Array.from(variants).filter((s) => s.length > 1);
}

export interface ProbeHit {
  name: string;
  provider: string;
  slug: string;
}

export async function probeOne(name: string): Promise<ProbeHit | null> {
  for (const slug of slugVariants(name)) {
    for (const { provider, url } of PROBES) {
      const ok = await probeUrl(url(slug));
      if (ok) return { name, provider, slug };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("usage: npm run probe -- <name> [<name> ...]");
    process.exit(1);
  }

  for (const name of names) {
    const hit = await probeOne(name);
    if (hit) {
      console.log(`HIT  ${name.padEnd(30)} → ${hit.provider}/${hit.slug}`);
    } else {
      console.log(`MISS ${name.padEnd(30)} (custom / llm-scrape)`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("probe failed:", err);
    process.exit(1);
  });
}
