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
import { ATS_URL_BUILDERS, probeJsonBoard } from "./ats-probes.js";

const PROBE_PROVIDERS = ["greenhouse", "lever", "ashby"] as const;

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
    for (const provider of PROBE_PROVIDERS) {
      const build = ATS_URL_BUILDERS[provider];
      if (!build) continue;
      const ok = await probeJsonBoard(build(slug));
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
