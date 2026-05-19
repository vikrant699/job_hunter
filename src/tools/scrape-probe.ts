/**
 * llm-scrape probe — test the new scraper against one company.
 *
 *   npm run scrape -- <slug>             # shortlist + LLM, no JD fetch
 *   npm run scrape -- <slug> --jd        # also fetch the first JD
 *   npm run scrape -- <slug> --no-llm    # cheerio shortlist only (skip LLM)
 *   npm run scrape -- <slug> --html-head # dump first 1000 chars of fetched HTML
 *
 * Slug must match an entry in companies.seed.json (typically source=custom).
 */
import "dotenv/config";
import * as cheerio from "cheerio";
import { syncRegistryFromJson } from "../registry/companies.js";
import { selectActiveCompanies } from "../db/index.js";
import { llmScrapeAdapter } from "../scraper/llm-scrape.js";
import { fetchHtml, extractLinkShortlist } from "../scraper/cheerio.js";
import { runShortlist } from "../llm/shortlist.js";

function dumpAllAnchors(html: string, baseUrl: string): void {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const rows: Array<{ url: string; text: string }> = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().trim().replace(/\s+/g, " ");
    let abs: URL;
    try { abs = new URL(href, baseUrl); } catch { return; }
    const absStr = abs.toString().split("#")[0];
    if (!absStr || seen.has(absStr)) return;
    seen.add(absStr);
    rows.push({ url: absStr, text });
  });
  console.log(`\nAll anchors (${rows.length}):`);
  for (const r of rows.slice(0, 80)) {
    console.log(`  ${r.text.slice(0, 50).padEnd(50)} → ${r.url}`);
  }
  if (rows.length > 80) console.log(`  ... ${rows.length - 80} more`);
}

async function probeOne(
  company: ReturnType<typeof selectActiveCompanies>[number],
  flags: Set<string>
): Promise<void> {
  console.log(`\n--- ${company.name}  (${company.provider}/${company.slug}) ---`);
  console.log(`Careers URL: ${company.careersUrl}`);
  console.log(`Strategy:    ${company.parsingStrategy}\n`);

  // Stage A — raw cheerio shortlist (no LLM).
  let page;
  try {
    page = await fetchHtml(company.careersUrl);
  } catch (err) {
    console.log(`fetch failed: ${String(err).slice(0, 200)}`);
    return;
  }
  console.log(`Fetched: ${page.finalUrl}   (${page.html.length} bytes)`);
  if (flags.has("--html-head")) {
    console.log(`\n--- HTML head ---\n${page.html.slice(0, 1000)}\n--- end ---\n`);
  }
  if (flags.has("--dump-anchors")) {
    dumpAllAnchors(page.html, page.finalUrl);
  }

  const candidates = extractLinkShortlist(page.html, page.finalUrl);
  console.log(`\nCheerio candidates: ${candidates.length}`);
  for (const c of candidates.slice(0, 25)) {
    console.log(`  ${c.text.slice(0, 60).padEnd(60)} → ${c.url}`);
  }
  if (candidates.length > 25) console.log(`  ... ${candidates.length - 25} more`);

  if (flags.has("--no-llm")) return;
  if (candidates.length === 0) {
    console.log(`\n[no candidates → SPA likely, llm-scrape can't read this page]`);
    return;
  }

  // Stage B — LLM shortlist via the adapter (uses cache if warm).
  console.log(`\n--- LLM shortlist ---`);
  const jobs = await runShortlist({ companyName: company.name, candidates });
  console.log(`Picked ${jobs.length}:`);
  for (const j of jobs.slice(0, 25)) {
    console.log(`  ${j.title.slice(0, 60).padEnd(60)} → ${j.url}`);
  }
  if (jobs.length > 25) console.log(`  ... ${jobs.length - 25} more`);

  // Stage C — fetch first JD if requested.
  if (flags.has("--jd") && jobs.length > 0 && llmScrapeAdapter.fetchJd) {
    const first = jobs[0]!;
    console.log(`\n--- Fetching JD: ${first.title} ---`);
    const stub = {
      provider: company.provider,
      externalId: first.url,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: first.title,
      jobUrl: first.url,
      location: null,
      isRemote: false,
      jdText: "",
      postedAt: null,
    };
    const jd = await llmScrapeAdapter.fetchJd(
      {
        provider: company.provider,
        slug: company.slug,
        name: company.name,
        careersUrl: company.careersUrl,
        tenantUrl: company.tenantUrl,
      },
      stub
    );
    console.log(`Title pre-fetch:  ${first.title}`);
    console.log(`Title post-fetch: ${stub.jobTitle}`);
    console.log(`\nJD (${jd.length} chars):\n${jd.slice(0, 1200)}${jd.length > 1200 ? "\n[...]" : ""}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const slugs = args.filter((a) => !a.startsWith("--"));

  if (slugs.length === 0) {
    console.error("usage: npm run scrape -- <slug> [<slug> ...] [--jd] [--no-llm] [--html-head] [--dump-anchors]");
    process.exit(1);
  }

  syncRegistryFromJson();
  const all = selectActiveCompanies();

  for (const slug of slugs) {
    const company = all.find((c) => c.slug === slug);
    if (!company) {
      console.error(`No active company with slug=${slug}; skipping`);
      continue;
    }
    try {
      await probeOne(company, flags);
    } catch (err) {
      console.error(`probe ${slug} failed: ${String(err).slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(`scrape-probe failed: ${err}`);
  process.exit(1);
});
