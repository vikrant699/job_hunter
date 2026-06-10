/** Probe every registry entry (ATS slug or careers URL) and report failures. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../src/config.js";
import { RegistryEntrySchema, type RegistryEntry } from "../src/schemas.js";
import { probeOne } from "./slug-probe.js";
import { BROWSER_UA } from "../src/util/user-agent.js";

interface Probe {
  url: string;
  ok: boolean;
}

interface Result {
  entry: RegistryEntry;
  kind: "ats" | "url";
  ok: boolean;
  probe: Probe | null;
  suggestion: { provider: string; slug: string } | null;
}

const ATS_URL_BUILDERS: Record<string, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=false`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=false`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=1`,
};

const VERIFY_UA = "Mozilla/5.0 (verify-registry/0.1)";

async function probeWorkday(tenantUrl: string | undefined): Promise<boolean> {
  if (!tenantUrl) return false;
  const m = /^https?:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.myworkdayjobs\.com\/([A-Za-z0-9_-]+)/i.exec(tenantUrl);
  if (!m || !m[1] || !m[2] || !m[3]) return false;
  const [, tenant, region, site] = m;
  const cxsUrl = `https://${tenant}.${region}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  try {
    const res = await fetch(cxsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": VERIFY_UA },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    // A live CXS endpoint that answers with the expected JSON shape is a valid
    // tenant even with zero current openings (matches ats-validate.ts).
    const parsed = z.object({ total: z.number().optional() }).safeParse(await res.json());
    return parsed.success;
  } catch {
    return false;
  }
}

async function probeUrl(url: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      // ok (2xx, post-redirect) or 403 = page exists but bot-blocks GETs.
      // 404/410 means the careers page is actually gone — that's the point
      // of this script, so don't paper over it.
      return res.ok || res.status === 403;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function probeAtsBody(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const text = await res.text();
      if (text.length < 10) return false;
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

async function checkAts(entry: RegistryEntry, suggest: boolean): Promise<Result> {
  const slug = entry.source_slug ?? "";

  if (entry.source === "workday") {
    const ok = await probeWorkday(entry.tenant_url);
    let suggestion: Result["suggestion"] = null;
    if (!ok && suggest) {
      const hit = await probeOne(entry.name);
      if (hit) suggestion = { provider: hit.provider, slug: hit.slug };
    }
    return {
      entry,
      kind: "ats",
      ok,
      probe: { url: entry.tenant_url ?? "(no tenant_url)", ok },
      suggestion,
    };
  }

  const builder = ATS_URL_BUILDERS[entry.source];
  if (!builder) {
    // No public probe for this provider (or it needs api_meta tokens we can't
    // synthesize, e.g. keka/eightfold/oracle). Fall back to probing the careers
    // page rather than reporting a false "broken".
    return checkUrl(entry, suggest);
  }

  const url = builder(slug);
  const ok = await probeAtsBody(url);
  let suggestion: Result["suggestion"] = null;
  if (!ok && suggest) {
    const hit = await probeOne(entry.name);
    if (hit) suggestion = { provider: hit.provider, slug: hit.slug };
  }

  return { entry, kind: "ats", ok, probe: { url, ok }, suggestion };
}

async function checkUrl(entry: RegistryEntry, suggest: boolean): Promise<Result> {
  const ok = await probeUrl(entry.careers_url);
  let suggestion: Result["suggestion"] = null;
  if (!ok && suggest) {
    const hit = await probeOne(entry.name);
    if (hit) suggestion = { provider: hit.provider, slug: hit.slug };
  }
  return { entry, kind: "url", ok, probe: { url: entry.careers_url, ok }, suggestion };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const onlyBroken = args.has("--only-broken");
  const suggest = args.has("--suggest");

  const registryPath = resolve(process.cwd(), config.storage.registryPath);
  const entries = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(registryPath, "utf-8")));

  console.log(`Verifying ${entries.length} entries from ${registryPath}`);
  if (suggest) console.log(`(--suggest: will probe other ATSes for failed entries — slower)`);
  console.log("");

  const checkable = entries.filter((e) => e.status !== "denied");

  const BATCH = 8;
  const results: Result[] = [];
  for (let i = 0; i < checkable.length; i += BATCH) {
    const batch = checkable.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map((e) =>
        e.parsing_strategy === "ats-api" ? checkAts(e, suggest) : checkUrl(e, suggest),
      ),
    );
    results.push(...batchResults);
    process.stdout.write(`  ${Math.min(i + BATCH, checkable.length)}/${checkable.length}\r`);
  }
  console.log("");
  console.log("");

  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);

  if (!onlyBroken) console.log(`OK:     ${successes.length}`);
  console.log(`Broken: ${failures.length}`);
  console.log("");

  for (const r of failures) {
    const tag = r.kind === "ats" ? `[${r.entry.source}/${r.entry.source_slug}]` : `[url]`;
    console.log(`✗ ${r.entry.name}  ${tag}`);
    console.log(`    ${r.probe?.url}`);
    if (r.suggestion) {
      console.log(`    → suggest: source=${r.suggestion.provider}, source_slug=${r.suggestion.slug}, parsing_strategy=ats-api`);
    } else if (suggest) {
      console.log(`    → no ATS hit; consider llm-scrape or fix the careers_url`);
    }
  }

  const atsBroken = failures.filter((r) => r.kind === "ats").length;
  const urlBroken = failures.filter((r) => r.kind === "url").length;
  console.log("");
  console.log(`Summary: ${atsBroken} ATS slugs broken, ${urlBroken} careers URLs broken`);
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
