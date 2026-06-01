// src/eval/dataset.ts
import { DatabaseSync } from "node:sqlite";

export interface LabeledPosting {
  id: string;              // provider:external_id
  provider: string;
  company: string;
  title: string;
  jdText: string;
  storedScore: number | null; // llm_confidence from the production run
  relevant: boolean;
}

interface Row {
  id: string;
  provider: string;
  company: string | null;
  title: string | null;
  jd_text: string | null;
  stored_score: number | null;
}

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
  `).all() as unknown as Row[];

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
