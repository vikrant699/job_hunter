import "dotenv/config";
import { writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { buildCsv } from "../src/util/csv.js";
import { runGate } from "../src/llm/gate.js";
import { loadLabels } from "./labels.js";
import { loadLabeledPostings } from "./dataset.js";
import {
  rocAuc, recallAtThreshold, precisionAtThreshold,
  maxThresholdForFullRecall, scoreSpread, type ScoredLabel,
} from "./metrics.js";

function flag(name: string, def: string): string;
function flag(name: string, def: null): string | null;
function flag(name: string, def: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  if (i >= 0 && next && !next.startsWith("--")) return next;
  return def;
}

const dbPath = flag("db", config.storage.dbPath);
const labelsPath = flag("labels", process.env.REVIEW_LABELS ?? "data/review-labels.csv");
const promptName = flag("prompt", "baseline");
const sampleN = flag("sample", null);
const outPath = flag("out", null);
const tempArg = flag("temp", null); // e.g. 0 for deterministic scoring
const temperature = tempArg != null ? Number(tempArg) : undefined;

// When a genuinely new prompt variant is being evaluated, add it here with a real name.
const CANDIDATES: Record<string, string> = { current: config.prompts.gate };

function stratifiedSample(rows: ReturnType<typeof loadLabeledPostings>, n: number) {
  const pos = rows.filter((r) => r.relevant);
  const neg = rows.filter((r) => !r.relevant);
  const ratio = Math.min(1, n / rows.length);
  const take = <T,>(a: T[]) => a.slice(0, Math.max(1, Math.round(a.length * ratio)));
  return [...take(pos), ...take(neg)];
}

function report(title: string, scored: ScoredLabel[]): void {
  const valid = scored.filter((s) => Number.isFinite(s.score));
  const spread = scoreSpread(valid.map((s) => s.score));
  console.log(`\n=== ${title} (${valid.length} scored) ===`);
  console.log(`  ROC-AUC ......................... ${rocAuc(valid).toFixed(3)}`);
  console.log(`  distinct scores ................. ${spread.distinct}`);
  console.log(`  modal score ..................... ${spread.modal} (${(100 * spread.modalShare).toFixed(0)}% of rows)`);
  console.log(`  max threshold @ 100% recall ..... ${maxThresholdForFullRecall(valid).toFixed(2)}`);
  console.log(`  thr | recall |  prec | kept`);
  const cell = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "—").padStart(5);
  for (const t of [0.4, 0.5, 0.6, 0.7, 0.8]) {
    const kept = valid.filter((s) => s.score >= t).length;
    console.log(`  ${t.toFixed(1)} | ${cell(recallAtThreshold(valid, t))} | ${cell(precisionAtThreshold(valid, t))} | ${kept}`);
  }
}

const { labels, skipped } = loadLabels(labelsPath);
let rows = loadLabeledPostings(dbPath, labels);
console.log(`loaded ${rows.length} labeled postings (labels: ${labels.size}, skipped reactions: ${skipped})`);
if (rows.length === 0) {
  console.error("no labeled postings found — check --labels path and that the DB matches the run that produced them");
  process.exit(1);
}
if (sampleN) {
  const n = Number(sampleN);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--sample must be a positive number (got '${sampleN}')`);
    process.exit(1);
  }
  rows = stratifiedSample(rows, n);
  console.log(`sampled down to ${rows.length} (stratified by label)`);
}

// Baseline: the production scores already in the DB. No model calls.
const baseline: ScoredLabel[] = rows
  .flatMap((r) => r.storedScore != null ? [{ score: r.storedScore, relevant: r.relevant }] : []);
report("BASELINE (stored llm_confidence)", baseline);

if (promptName !== "baseline") {
  const template = CANDIDATES[promptName];
  if (!template) {
    console.error(`unknown --prompt '${promptName}' (use: baseline | current)`);
    process.exit(1);
  }

  const scored: ScoredLabel[] = [];
  const detailed: Array<{ id: string; company: string; title: string; relevant: boolean; score: number }> = [];
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const g = await runGate(
        { jobTitle: r.title, companyName: r.company, jdText: r.jdText },
        { promptTemplate: template, temperature },
      );
      scored.push({ score: g.matchScore, relevant: r.relevant });
      detailed.push({ id: r.id, company: r.company, title: r.title, relevant: r.relevant, score: g.matchScore });
    } catch {
      failed++;
    }
    if (++done % 20 === 0) console.error(`  scored ${done}/${rows.length}...`);
  }
  report(`CANDIDATE '${promptName}'`, scored);
  if (failed > 0) console.log(`  (${failed} gate failures excluded from metrics)`);

  if (outPath) {
    const sortedRows = detailed
      .sort((a, b) => a.score - b.score) // ascending by score: relevant rows scored low (false negatives) sort to the top for inspection
      .map((d) => [d.id, d.company, d.title, d.relevant, d.score] as const);
    writeFileSync(outPath, buildCsv(["id", "company", "title", "relevant", "score"], sortedRows), "utf-8");
    console.log(`  wrote per-row scores → ${outPath} (ascending by score)`);
  }
}
