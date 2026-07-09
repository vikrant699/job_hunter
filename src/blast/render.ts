// src/blast/render.ts
//
// Variant rotation + company-mention personalization for blast emails.
// Subject/opener text is user-approved verbatim (design spec, Content
// section). Hard rule from the user: NO em dashes in outgoing mail.
import { readFileSync } from "node:fs";

export const SUBJECTS: readonly string[] = [
  "Looking for Senior Data Analyst Opportunities | 4.5 Years Experience | Immediate Joiner",
  "Senior Data Analyst | 4.5 Years Experience | Immediate Joiner | Open to All Locations",
  "Profile for Senior Data Analyst / BI Roles: 4.5 Years Experience, Immediate Joiner",
];

interface Opener {
  hello: string;
  withCompany: (company: string) => string;
  fallback: string;
}

export const OPENERS: readonly Opener[] = [
  {
    hello: "I hope you're doing well.",
    withCompany: (c) =>
      `I am reaching out to explore Senior Data Analyst and Business Intelligence opportunities that your team at ${c} may be hiring for.`,
    fallback:
      "I am reaching out to explore Senior Data Analyst and Business Intelligence opportunities that you may be hiring for.",
  },
  {
    hello: "I hope your week is going well.",
    withCompany: (c) =>
      `I'm writing to check whether you or your team at ${c} are currently hiring for Senior Data Analyst or Business Intelligence roles.`,
    fallback:
      "I'm writing to check whether you are currently hiring for Senior Data Analyst or Business Intelligence roles.",
  },
  {
    hello: "I hope you're doing well.",
    withCompany: (c) =>
      `I wanted to share my profile with ${c} for any Senior Data Analyst or BI openings you may be working on.`,
    fallback:
      "I wanted to share my profile for any Senior Data Analyst or BI openings you may be working on.",
  },
];

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
  }
  if (body.includes("—")) {
    throw new Error(`blast template at ${path} contains an em dash (banned in outgoing mail)`);
  }
  return { body };
}

export interface RenderInput {
  template: BlastTemplate;
  company: string;
  contactName: string | null;
  /** Global 0-based index over every address ever drafted; drives rotation
   *  (subject cycles every draft, opener every SUBJECTS.length drafts, so all
   *  9 combos appear before any repeats). */
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
  const si = input.rotationIndex % SUBJECTS.length;
  const oi = Math.floor(input.rotationIndex / SUBJECTS.length) % OPENERS.length;
  const subject = SUBJECTS[si];
  const opener = OPENERS[oi];
  if (subject === undefined || opener === undefined) {
    throw new Error(`blast render: no variant at rotation index ${String(input.rotationIndex)}`);
  }

  const company = companyForMention(input.company);
  const openerText = `${opener.hello}\n\n${company === null ? opener.fallback : opener.withCompany(company)}`;
  const bodyText = input.template.body
    .replace("{{greeting}}", greeting(input.contactName))
    .replace("{{opener}}", openerText);
  const variant = `S${String(si + 1)}/O${String(oi + 1)}${company === null ? "-fallback" : ""}`;
  return { subject, bodyText, variant };
}
