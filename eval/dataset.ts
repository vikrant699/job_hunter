// src/eval/dataset.ts
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export interface LabeledPosting {
  id: string;              // provider:external_id
  provider: string;
  company: string;
  title: string;
  jdText: string;
  storedScore: number | null; // llm_confidence from the production run
  relevant: boolean;
}

const RowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  jd_text: z.string().nullable(),
  stored_score: z.number().nullable(),
});
type Row = z.infer<typeof RowSchema>;

/** Pure-ish core: takes an open DB handle so it can be unit-tested with :memory:. */
export function buildLabeledPostings(
  db: DatabaseSync,
  labels: Map<string, boolean>,
): LabeledPosting[] {
  const rows = db.prepare(`
    SELECT p.provider || ':' || p.external_id AS id,
           p.provider                          AS provider,
           c.name                              AS company,
           p.job_title                         AS title,
           p.jd_text                           AS jd_text,
           p.llm_confidence                    AS stored_score
    FROM postings p
    LEFT JOIN companies c
      ON c.provider = p.provider AND c.slug = p.company_slug
    WHERE p.notified_at IS NOT NULL
  `).all().map((r) => RowSchema.parse(r));

  const out: LabeledPosting[] = [];
  for (const r of rows) {
    const rel = labels.get(r.id);
    if (rel === undefined) continue;
    out.push({
      id: r.id,
      provider: r.provider,
      company: r.company ?? "",
      title: r.title ?? "",
      jdText: r.jd_text ?? "",
      storedScore: r.stored_score,
      relevant: rel,
    });
  }
  return out;
}

/** Convenience wrapper that opens (and closes) the DB by path. */
export function loadLabeledPostings(
  dbPath: string,
  labels: Map<string, boolean>,
): LabeledPosting[] {
  const db = new DatabaseSync(dbPath);
  try {
    return buildLabeledPostings(db, labels);
  } finally {
    db.close();
  }
}
