import { readFileSync } from "node:fs";

/** Parsed outreach email template: subject line + body, both still containing
 *  {{placeholder}} tokens for renderDraft to fill in. */
export interface OutreachTemplate {
  subject: string;
  body: string;
}

/**
 * Reads a template file whose first line is `Subject: ...`, followed by a
 * blank line, then the body. Throws an actionable error if the file doesn't
 * match that shape.
 */
export function loadTemplate(path: string): OutreachTemplate {
  const raw = readFileSync(path, "utf-8");
  const newlineIndex = raw.indexOf("\n");
  const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);

  const subjectMatch = /^Subject:\s?(.*)$/.exec(firstLine.replace(/\r$/, ""));
  if (!subjectMatch) {
    throw new Error(
      `outreach template at ${path} is malformed: the first line must start with "Subject: " ` +
        `(got: ${JSON.stringify(firstLine.slice(0, 80))}).`,
    );
  }

  const rest = newlineIndex === -1 ? "" : raw.slice(newlineIndex + 1);
  const restNoLeadingCr = rest.startsWith("\r") ? rest.slice(1) : rest;
  if (!restNoLeadingCr.startsWith("\n") && !restNoLeadingCr.startsWith("\r\n")) {
    throw new Error(
      `outreach template at ${path} is malformed: expected a blank line after the Subject line.`,
    );
  }
  const body = restNoLeadingCr.startsWith("\r\n")
    ? restNoLeadingCr.slice(2)
    : restNoLeadingCr.slice(1);

  return { subject: subjectMatch[1] ?? "", body };
}

export interface DraftRole {
  title: string;
  jobUrl: string;
}

export interface RenderDraftInput {
  template: OutreachTemplate;
  contactName: string | null;
  company: string;
  roles: DraftRole[];
  senderName: string;
  profilePitch: string | null;
  senderLinks: string[];
}

export interface RenderedDraft {
  subject: string;
  bodyText: string;
}

function roleSummary(roles: DraftRole[]): string {
  const first = roles[0];
  if (!first) return "";
  return roles.length > 1 ? `${first.title} and ${roles.length - 1} more` : first.title;
}

function rolesBlock(roles: DraftRole[]): string {
  return roles.map((r) => `- ${r.title} (${r.jobUrl})`).join("\n");
}

function firstName(contactName: string | null): string {
  if (!contactName) return "there";
  const token = contactName.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : "there";
}

function buildPlaceholders(input: RenderDraftInput): Record<string, string> {
  return {
    contact_name_or_there: firstName(input.contactName),
    company: input.company,
    roles_block: rolesBlock(input.roles),
    role_summary: roleSummary(input.roles),
    s_if_plural: input.roles.length > 1 ? "s" : "",
    profile_pitch: input.profilePitch ? `${input.profilePitch}\n\n` : "",
    sender_name: input.senderName,
    sender_links: input.senderLinks.join(" | "),
  };
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function fill(text: string, placeholders: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in placeholders)) {
      throw new Error(`outreach template contains unknown placeholder "{{${name}}}"`);
    }
    return placeholders[name] ?? "";
  });
}

/** Pure renderer: fills {{placeholders}} in the template's subject and body.
 *  Throws if the template references a placeholder this function doesn't know
 *  how to fill. */
export function renderDraft(input: RenderDraftInput): RenderedDraft {
  const placeholders = buildPlaceholders(input);
  return {
    subject: fill(input.template.subject, placeholders),
    bodyText: fill(input.template.body, placeholders),
  };
}
