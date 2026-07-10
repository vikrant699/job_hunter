// src/blast/render.ts
//
// Variant rotation + company-mention personalization for blast emails.
// Subject/opener text is per-profile, user-approved verbatim, and lives in
// config/profiles/<profile>/blast-content.json (gitignored). Hard rule from
// the user: NO em dashes in outgoing mail.
import { readFileSync } from "node:fs";
import { z } from "zod";

const OpenerSchema = z.object({
  hello: z.string().min(1),
  /** Sentence containing a literal "{company}" token. */
  withCompany: z.string().min(1),
  fallback: z.string().min(1),
});
export type Opener = z.infer<typeof OpenerSchema>;

export const BlastContentSchema = z.object({
  /** Attachment filename shown to recipients, e.g. "Divya Rajput Resume.pdf". */
  resumeFilename: z.string().min(1),
  subjects: z.array(z.string().min(1)).min(1),
  openers: z.array(OpenerSchema).min(1),
});
export type BlastContent = z.infer<typeof BlastContentSchema>;

/** Load + validate a profile's outgoing-content config. Throws actionable
 *  errors on structural problems, a missing {company} token, or any em dash
 *  (banned in outgoing mail). */
export function loadBlastContent(path: string): BlastContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`blast content at ${path} is unreadable: ${String(err)}`);
  }
  const result = BlastContentSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`blast content at ${path} is malformed: ${issues}`);
  }
  const content = result.data;
  for (const o of content.openers) {
    if (!o.withCompany.includes("{company}")) {
      throw new Error(`blast content at ${path}: an opener's withCompany is missing the {company} token`);
    }
  }
  const allText = [content.resumeFilename, ...content.subjects, ...content.openers.flatMap((o) => [o.hello, o.withCompany, o.fallback])];
  if (allText.some((s) => s.includes("—"))) {
    throw new Error(`blast content at ${path} contains an em dash (banned in outgoing mail)`);
  }
  return content;
}

/** Sanity-gate a Raw Data company cell before weaving it into a sentence.
 *  Returns the cleaned name, or null (use the opener's fallback). Calibrated
 *  against the live tab (2026-07-09): kills "(unknown)", "C"/"CC"/"SS",
 *  "a prestigious European-based client", 60+-char org descriptions, and
 *  trims "| Leading IT Solutions Company" marketing tails. */
export function companyForMention(raw: string): string | null {
  const name = (raw.split("|")[0] ?? "").trim();
  if (name.length < 3 || name.length > 60) return null;
  if (name.startsWith("(")) return null;
  if (/^(a|an|the)\s/i.test(name)) return null;
  if (!/[a-zA-Z]/.test(name)) return null;
  if (/unknown/i.test(name)) return null;
  return name;
}

export interface BlastTemplate {
  /** Body with {{greeting}} and {{opener}} tokens still in place. */
  body: string;
}

export function loadBlastTemplate(path: string): BlastTemplate {
  const body = readFileSync(path, "utf-8");
  for (const token of ["{{greeting}}", "{{opener}}"]) {
    if (!body.includes(token)) {
      throw new Error(`blast template at ${path} is missing the ${token} token`);
    }
    if (body.split(token).length !== 2) {
      throw new Error(`blast template at ${path} must contain exactly one ${token} token`);
    }
  }
  if (body.includes("—")) {
    throw new Error(`blast template at ${path} contains an em dash (banned in outgoing mail)`);
  }
  return { body };
}

export interface RenderInput {
  template: BlastTemplate;
  content: BlastContent;
  company: string;
  contactName: string | null;
  /** Global 0-based index over every address ever drafted; drives rotation
   *  (subject cycles every draft, opener every subjects.length drafts, so all
   *  subject x opener combos appear before any repeats). */
  rotationIndex: number;
}

export interface RenderedBlast {
  subject: string;
  bodyText: string;
  /** e.g. "S2/O1", or "S2/O1-fallback" when the company failed the gate. */
  variant: string;
}

function greeting(contactName: string | null): string {
  if (contactName === null) return "Hi,";
  const first = contactName.trim().split(/\s+/)[0];
  return first !== undefined && first.length > 0 ? `Hi ${first},` : "Hi,";
}

export function renderBlast(input: RenderInput): RenderedBlast {
  const { subjects, openers } = input.content;
  const si = input.rotationIndex % subjects.length;
  const oi = Math.floor(input.rotationIndex / subjects.length) % openers.length;
  const subject = subjects[si];
  const opener = openers[oi];
  if (subject === undefined || opener === undefined) {
    throw new Error(`blast render: no variant at rotation index ${String(input.rotationIndex)}`);
  }

  const company = companyForMention(input.company);
  // Function replacers so `$&`/`$$` in names or companies insert literally
  // instead of being treated as replacement patterns.
  const openerBody =
    company === null ? opener.fallback : opener.withCompany.replace("{company}", () => company);
  const openerText = `${opener.hello}\n\n${openerBody}`;
  const bodyText = input.template.body
    .replace("{{greeting}}", () => greeting(input.contactName))
    .replace("{{opener}}", () => openerText);
  const variant = `S${String(si + 1)}/O${String(oi + 1)}${company === null ? "-fallback" : ""}`;
  return { subject, bodyText, variant };
}
