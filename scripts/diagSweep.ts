// Read-only diagnostic sweep (NOT part of the pipeline, safe to delete); writes NDJSON incrementally so a crash loses nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { selectActiveCompanies } from "../src/db/index.js";
import { resolveAdapter } from "../src/ats/registry.js";
import { describeError, isInfrastructureFault } from "../src/util/errorCause.js";
import { sleep } from "../src/util/sleep.js";
import type { AtsAdapter } from "../src/ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "../src/types.js";

const RowKeySchema = z.object({ provider: z.string(), slug: z.string() });

const INDIA_RE =
  /\b(india|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|gurgaon|gurugram|noida|new delhi|delhi|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|thiruvananthapuram|trivandrum|chandigarh|mohali|vadodara|nagpur|remote)\b/i;

const COMMON_PAGE_SIZES = new Set([10, 20, 25, 30, 50, 100]);

const JD_SAMPLES = 3;
const LIST_TIMEOUT_MS = 12 * 60_000;
const JD_TIMEOUT_MS = 90_000;
const GLOBAL_LIMIT = 24;

interface JdSample {
  externalId: string;
  title: string;
  location: string | null;
  fromList: boolean;
  jdLen: number;
  flags: string[];
  error: string | null;
}

interface CompanyDiag {
  provider: string;
  slug: string;
  name: string;
  strategy: string;
  listedCount: number | null;
  listMs: number;
  error: string | null;
  errorInfra: boolean;
  dupExternalIds: number;
  missingExternalId: number;
  missingUrl: number;
  missingTitle: number;
  nullLocation: number;
  nullPostedAt: number;
  indiaCount: number;
  jdInListCount: number;
  listJdEmpty: number;
  listJdThin: number;
  roundCountSuspect: boolean;
  hasFetchJd: boolean;
  samples: JdSample[];
  identicalSampleJds: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`diag-timeout: ${tag} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function jdFlags(jd: string, title: string): string[] {
  const flags: string[] = [];
  const text = jd.trim();
  if (text.length === 0) {
    flags.push("empty");
    return flags;
  }
  if (text.length < 300) flags.push("thin");
  const tagMatches = text.match(/<\/?[a-z][a-z0-9-]*[\s/>]/gi);
  if (tagMatches && tagMatches.length > 3) flags.push("html-residue");
  if (
    /access denied|request unsuccessful|are you a human|captcha|enable javascript|page not found|error 404|session expired|temporarily unavailable|pardon our interruption/i.test(
      text.slice(0, 600),
    )
  ) {
    flags.push("error-page");
  }
  if (text.toLowerCase() === title.trim().toLowerCase()) flags.push("title-only");
  return flags;
}

function pickSamples(postings: NormalizedPosting[]): NormalizedPosting[] {
  const india = postings.filter((p) => !p.location || p.isRemote || INDIA_RE.test(p.location));
  const pool = india.length > 0 ? india : postings;
  if (pool.length <= JD_SAMPLES) return pool.slice(0, JD_SAMPLES);
  const picks = new Set<number>([0, Math.floor(pool.length / 2), pool.length - 1]);
  return [...picks].map((i) => pool[i]).filter((p): p is NormalizedPosting => p !== undefined);
}

function toAdapterCompany(c: Company): AdapterCompany {
  return {
    provider: c.provider,
    slug: c.slug,
    name: c.name,
    careersUrl: c.careersUrl,
    tenantUrl: c.tenantUrl,
    apiMeta: c.apiMeta,
  };
}

async function diagnoseCompany(adapter: AtsAdapter, company: Company): Promise<CompanyDiag> {
  const d: CompanyDiag = {
    provider: company.provider,
    slug: company.slug,
    name: company.name,
    strategy: company.parsingStrategy,
    listedCount: null,
    listMs: 0,
    error: null,
    errorInfra: false,
    dupExternalIds: 0,
    missingExternalId: 0,
    missingUrl: 0,
    missingTitle: 0,
    nullLocation: 0,
    nullPostedAt: 0,
    indiaCount: 0,
    jdInListCount: 0,
    listJdEmpty: 0,
    listJdThin: 0,
    roundCountSuspect: false,
    hasFetchJd: typeof adapter.fetchJd === "function",
    samples: [],
    identicalSampleJds: false,
  };

  const adapterCompany = toAdapterCompany(company);
  const t0 = Date.now();
  let postings: NormalizedPosting[];
  try {
    postings = await withTimeout(
      adapter.listPostings(adapterCompany),
      LIST_TIMEOUT_MS,
      `${company.provider}/${company.slug} list`,
    );
  } catch (err) {
    d.listMs = Date.now() - t0;
    d.error = describeError(err).slice(0, 300);
    d.errorInfra = isInfrastructureFault(err);
    return d;
  }
  d.listMs = Date.now() - t0;
  d.listedCount = postings.length;

  const seen = new Set<string>();
  for (const p of postings) {
    if (!p.externalId) d.missingExternalId++;
    else if (seen.has(p.externalId)) d.dupExternalIds++;
    else seen.add(p.externalId);
    if (!p.jobUrl) d.missingUrl++;
    if (!p.jobTitle || p.jobTitle.trim() === "") d.missingTitle++;
    if (p.location === null || p.location === "") d.nullLocation++;
    if (p.postedAt === null) d.nullPostedAt++;
    if (p.location !== null && INDIA_RE.test(p.location)) d.indiaCount++;
    if (p.jdText && p.jdText.trim() !== "") {
      d.jdInListCount++;
      if (p.jdText.trim().length < 300) d.listJdThin++;
    } else {
      d.listJdEmpty++;
    }
  }

  d.roundCountSuspect =
    postings.length > 0 &&
    (COMMON_PAGE_SIZES.has(postings.length) || (postings.length >= 200 && postings.length % 100 === 0));

  // JD sampling: reuse list-provided text when present, otherwise fetchJd.
  const samples = pickSamples(postings);
  const jdBodies: string[] = [];
  for (const p of samples) {
    const s: JdSample = {
      externalId: p.externalId,
      title: p.jobTitle,
      location: p.location,
      fromList: Boolean(p.jdText && p.jdText.trim() !== ""),
      jdLen: 0,
      flags: [],
      error: null,
    };
    let jd = p.jdText;
    if ((!jd || jd.trim() === "") && adapter.fetchJd) {
      try {
        jd = await withTimeout(
          adapter.fetchJd(adapterCompany, p),
          JD_TIMEOUT_MS,
          `${company.provider}/${company.slug} jd ${p.externalId}`,
        );
      } catch (err) {
        s.error = describeError(err).slice(0, 200);
        d.samples.push(s);
        continue;
      }
    }
    s.jdLen = jd.trim().length;
    s.flags = jdFlags(jd, p.jobTitle);
    if (jd.trim() !== "") jdBodies.push(jd.trim());
    d.samples.push(s);
    await sleep(250);
  }
  if (jdBodies.length >= 2 && new Set(jdBodies).size === 1) d.identicalSampleJds = true;

  return d;
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  const providerFilter = process.argv[3];
  if (!outDir) throw new Error("usage: tsx scripts/diagSweep.ts <outDir> [providerFilter]");
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, "results.ndjson");

  // Resume: skip companies already present in an existing results file.
  const alreadyDone = new Set<string>();
  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = RowKeySchema.parse(JSON.parse(line));
        alreadyDone.add(`${r.provider} ${r.slug}`);
      } catch { /* partial trailing line from a killed run — redo it */ }
    }
  } else {
    writeFileSync(resultsPath, "");
  }

  const all = selectActiveCompanies();
  const apiCompanies = all.filter(
    (c) =>
      c.parsingStrategy === "ats-api" &&
      (providerFilter === undefined || c.provider === providerFilter) &&
      !alreadyDone.has(`${c.provider} ${c.slug}`),
  );
  if (alreadyDone.size > 0) console.error(`resume: skipping ${alreadyDone.size} already-diagnosed companies`);
  const scrapeRows = all.filter((c) => c.parsingStrategy !== "ats-api");
  writeFileSync(
    join(outDir, "scrape-rows.json"),
    JSON.stringify(
      scrapeRows.map((c) => ({ provider: c.provider, slug: c.slug, name: c.name, strategy: c.parsingStrategy })),
      null,
      2,
    ),
  );

  console.error(`diag sweep: ${apiCompanies.length} ats-api companies (${scrapeRows.length} scrape rows listed separately)`);

  // Bucket by provider, mirroring the production scheduler; gentler caps.
  const buckets = new Map<string, Company[]>();
  for (const c of apiCompanies) {
    const b = buckets.get(c.provider);
    if (b) b.push(c);
    else buckets.set(c.provider, [c]);
  }

  let globalInFlight = 0;
  const globalWaiters: Array<() => void> = [];
  const acquireGlobal = (): Promise<void> => {
    if (globalInFlight < GLOBAL_LIMIT) {
      globalInFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => globalWaiters.push(() => { globalInFlight++; resolve(); }));
  };
  const releaseGlobal = (): void => {
    globalInFlight--;
    const next = globalWaiters.shift();
    if (next) next();
  };

  let done = 0;
  const total = apiCompanies.length;
  const failedInfra: Array<{ adapter: AtsAdapter; company: Company }> = [];

  async function runOne(adapter: AtsAdapter, company: Company): Promise<void> {
    await acquireGlobal();
    try {
      const diag = await diagnoseCompany(adapter, company);
      if (diag.error !== null && diag.errorInfra) failedInfra.push({ adapter, company });
      appendFileSync(resultsPath, JSON.stringify(diag) + "\n");
    } catch (err) {
      appendFileSync(
        resultsPath,
        JSON.stringify({
          provider: company.provider,
          slug: company.slug,
          name: company.name,
          strategy: company.parsingStrategy,
          error: `diag-crash: ${describeError(err).slice(0, 300)}`,
        }) + "\n",
      );
    } finally {
      releaseGlobal();
      done++;
      if (done % 25 === 0 || done === total) console.error(`progress: ${done}/${total}`);
    }
  }

  const bucketTasks = [...buckets.entries()].map(async ([provider, companies]) => {
    const first = companies[0];
    const adapterProbe = first === undefined ? null : resolveAdapter(first);
    if (adapterProbe === null) {
      for (const c of companies) {
        appendFileSync(
          resultsPath,
          JSON.stringify({ provider: c.provider, slug: c.slug, name: c.name, strategy: c.parsingStrategy, error: "no adapter resolves" }) + "\n",
        );
        done += 1;
      }
      return;
    }
    const adapter: AtsAdapter = adapterProbe;
    // Workday: proven edge throttle on bursts — strictly sequential with 2.5s gaps.
    const cap = provider === "workday" ? 1 : 2;
    const gapMs = provider === "workday" ? 2_500 : 300;
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < companies.length) {
        const idx = cursor++;
        const c = companies[idx];
        if (!c) return;
        await runOne(adapter, c);
        await sleep(gapMs);
      }
    }
    await Promise.all(Array.from({ length: cap }, () => worker()));
  });

  await Promise.all(bucketTasks);

  // One paced retry pass for infrastructure failures, like the production run.
  if (failedInfra.length > 0) {
    console.error(`retry pass: ${failedInfra.length} infra-failed boards, sequential 3s apart`);
    const retryPath = join(outDir, "retry.ndjson");
    writeFileSync(retryPath, "");
    for (const [i, f] of failedInfra.entries()) {
      if (i > 0) await sleep(3_000);
      const diag = await diagnoseCompany(f.adapter, f.company);
      appendFileSync(retryPath, JSON.stringify(diag) + "\n");
    }
  }

  console.error("diag sweep complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("diag sweep failed:", err);
  process.exit(1);
});
