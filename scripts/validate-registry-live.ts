/**
 * Live-validation harness: does a registry row actually produce postings?
 *
 * This became the ONLY check that a conversion works. Conversions used to land as
 * `candidate`, so an unproven row was visible from its status; `candidate` was removed on
 * 2026-08-02 because it behaved identically to `active` everywhere. Nothing now marks a
 * freshly-repointed row as unproven — so run this against anything you just converted.
 *
 * Read-only. Calls each row's real adapter exactly as the pipeline would, and reports what
 * came back. It never writes to the DB or the sheet.
 *
 * A row returning 0 postings is NOT automatically a failure — a correctly-configured board
 * with nothing open today is a legitimate `ats-api` row (one cheap API call instead of a
 * browser render, and it produces the moment they post). Failures are throws.
 *
 * Requests are paced and sequential ON PURPOSE. Firing a provider's tenants concurrently is
 * what got us served HTML challenge pages instead of JSON on 2026-08-01: 17 Workday boards
 * failed inside a 24-second window, and all 17 returned jobs normally when re-probed 2.5s
 * apart. A validator that reproduces the bug it is meant to detect is worse than useless.
 *
 * Usage:
 *   npx tsx scripts/validate-registry-live.ts --provider keka
 *   npx tsx scripts/validate-registry-live.ts --name "HDFC Bank" --name Goodera
 *   npx tsx scripts/validate-registry-live.ts --converted-today
 *   npx tsx scripts/validate-registry-live.ts --all-ats [--pace 3000]
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { ATS_ADAPTERS } from "../src/ats/registry.js";
import { describeError } from "../src/util/error-cause.js";
import { ProviderSchema } from "../src/schemas.js";
import type { AdapterCompany } from "../src/types.js";
import type { AtsAdapter } from "../src/ats/types.js";
import { CONVERSIONS } from "./apply-conversions-2026-08-02.js";

const INDIA_RE =
  /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|gurgaon|gurugram|noida|mumbai|delhi|kolkata|ahmedabad|jaipur|kochi|coimbatore|trivandrum|indore|nagpur|mysuru|mysore|chandigarh|vadodara|surat)\b/i;

const DEFAULT_PACE_MS = 2_500;

function argValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) {
      const v = process.argv[i + 1];
      if (v !== undefined) out.push(v);
    }
  }
  return out;
}

interface Row {
  provider: string; slug: string; name: string; status: string;
  careersUrl: string; tenantUrl: string | null; apiMeta: string | null;
}

function loadRows(): Row[] {
  const db = new DatabaseSync("data/job_hunter.db", { readOnly: true });
  const providers = argValues("--provider");
  const names = argValues("--name");

  let where = "parsing_strategy = 'ats-api' AND status = 'active'";
  const params: string[] = [];
  if (providers.length > 0) {
    where += ` AND provider IN (${providers.map(() => "?").join(",")})`;
    params.push(...providers);
  }
  if (names.length > 0) {
    where += ` AND name IN (${names.map(() => "?").join(",")})`;
    params.push(...names);
  }
  // `evidence` lives only on the sheet, not in the companies table, so the conversion set is
  // taken from the script that wrote it — exact, and it cannot drift out of sync.
  if (process.argv.includes("--converted-today")) {
    const names = CONVERSIONS.map((c) => c.name);
    where += ` AND name IN (${names.map(() => "?").join(",")})`;
    params.push(...names);
  }

  const sql = `SELECT provider, slug, name, status, careers_url, tenant_url, api_meta
               FROM companies WHERE ${where} ORDER BY provider, slug`;
  return db.prepare(sql).all(...params).map((r) => ({
    provider: typeof r.provider === "string" ? r.provider : "",
    slug: typeof r.slug === "string" ? r.slug : "",
    name: typeof r.name === "string" ? r.name : "",
    status: typeof r.status === "string" ? r.status : "",
    careersUrl: typeof r.careers_url === "string" ? r.careers_url : "",
    tenantUrl: typeof r.tenant_url === "string" && r.tenant_url.length > 0 ? r.tenant_url : null,
    apiMeta: typeof r.api_meta === "string" && r.api_meta.length > 0 ? r.api_meta : null,
  }));
}

/** api_meta is stored as a JSON string of string values; adapters want the parsed record. */
function parseApiMeta(raw: string | null): Record<string, string> | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Result { name: string; ref: string; ok: boolean; total: number; india: number; sample: string; err: string }

async function main(): Promise<void> {
  const rows = loadRows();
  const paceArg = argValues("--pace")[0];
  const pace = paceArg === undefined ? DEFAULT_PACE_MS : Number(paceArg);
  if (rows.length === 0) {
    console.log("no rows matched — pass --provider, --name, --converted-today or --all-ats");
    return;
  }
  console.log(`validating ${rows.length} rows sequentially, ${pace}ms apart\n`);

  const results: Result[] = [];
  for (const [i, r] of rows.entries()) {
    const ref = `${r.provider}/${r.slug}`;
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${rows.length}] ${r.name.slice(0, 26).padEnd(27)} ${ref.slice(0, 28).padEnd(29)} `);
    // Validate the stored provider string against the enum rather than indexing the adapter
    // map with an arbitrary string — type assertions are lint-banned repo-wide.
    const parsedProvider = ProviderSchema.safeParse(r.provider);
    let adapter: AtsAdapter | undefined;
    if (parsedProvider.success && parsedProvider.data !== "custom") adapter = ATS_ADAPTERS[parsedProvider.data];
    if (!parsedProvider.success || parsedProvider.data === "custom" || adapter === undefined) {
      results.push({ name: r.name, ref, ok: false, total: 0, india: 0, sample: "", err: `no adapter for provider '${r.provider}'` });
      console.log(`NO-ADAPTER`);
      continue;
    }
    const company: AdapterCompany = {
      provider: parsedProvider.data, slug: r.slug, name: r.name,
      careersUrl: r.careersUrl, tenantUrl: r.tenantUrl, apiMeta: parseApiMeta(r.apiMeta),
    };
    try {
      const postings = await adapter.listPostings(company);
      const india = postings.filter((p) => INDIA_RE.test(p.location ?? "")).length;
      const first = postings[0];
      results.push({
        name: r.name, ref, ok: true, total: postings.length, india,
        sample: first === undefined ? "" : `${first.jobTitle} | ${first.location ?? "?"}`, err: "",
      });
      console.log(`OK    total=${String(postings.length).padStart(5)}  india=${String(india).padStart(5)}`);
    } catch (err) {
      results.push({ name: r.name, ref, ok: false, total: 0, india: 0, sample: "", err: describeError(err).slice(0, 160) });
      console.log(`FAIL  ${describeError(err).slice(0, 90)}`);
    }
    if (i < rows.length - 1) await sleep(pace);
  }

  const failed = results.filter((r) => !r.ok);
  const empty = results.filter((r) => r.ok && r.total === 0);
  const producing = results.filter((r) => r.ok && r.total > 0);
  console.log(`\n=== ${producing.length} producing · ${empty.length} reachable-but-empty · ${failed.length} FAILED ===`);
  console.log(`India postings across all rows: ${producing.reduce((s, r) => s + r.india, 0)}`);

  if (empty.length > 0) {
    console.log(`\nreachable but empty (fine — not a failure):`);
    for (const e of empty) console.log(`  ${e.name.padEnd(28)} ${e.ref}`);
  }
  if (failed.length > 0) {
    console.log(`\nFAILED — these need a config fix or a retirement:`);
    for (const f of failed) console.log(`  ${f.name.padEnd(28)} ${f.ref}\n      ${f.err}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
