// Subject/opener text is per-profile, user-approved verbatim, in config/profiles/<profile>/blast-content.json (gitignored). Hard rule: no em dashes in outgoing mail.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const OpenerSchema = z.object({
  hello: z.string().min(1),
  withCompany: z.string().min(1),
  fallback: z.string().min(1),
});
export type Opener = z.infer<typeof OpenerSchema>;

export const BlastContentSchema = z.object({
  resumeFilename: z.string().min(1),
  subjects: z.array(z.string().min(1)).min(1),
  openers: z.array(OpenerSchema).min(1),
});
export type BlastContent = z.infer<typeof BlastContentSchema>;

export function loadBlastContent(path: string): BlastContent {
  let parsed: JsonValue;
  try {
    parsed = JsonValueSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
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
  /** Drives rotation so subject x opener combos all appear before any repeats. */
  rotationIndex: number;
}

export interface RenderedBlast {
  subject: string;
  bodyText: string;
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
  // Function replacers so `$&`/`$$` in names or companies insert literally, not as replacement patterns.
  const openerBody =
    company === null ? opener.fallback : opener.withCompany.replace("{company}", () => company);
  const openerText = `${opener.hello}\n\n${openerBody}`;
  const bodyText = input.template.body
    .replace("{{greeting}}", () => greeting(input.contactName))
    .replace("{{opener}}", () => openerText);
  const variant = `S${String(si + 1)}/O${String(oi + 1)}${company === null ? "-fallback" : ""}`;
  return { subject, bodyText, variant };
}
