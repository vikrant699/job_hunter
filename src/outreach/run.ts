import { existsSync, readFileSync } from "node:fs";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { profile, resumePdfPath } from "../profile.js";
import { syncContactsFromSheet } from "./contacts.js";
import { findContacts, type IneligibleReason } from "./match.js";
import { loadTemplate as loadTemplateDefault, renderDraft, type OutreachTemplate } from "./template.js";
import { buildDraftMime } from "../google/mime.js";
import { createDraft as createDraftDefault, type CreatedDraft } from "../google/gmail.js";
import { GoogleAuthExpiredError } from "../google/auth.js";
import { selectNotifiedPostingsSince, type OutreachNotifiedPosting } from "../db/postings.js";
import { selectAllRecruiters, type RecruiterRow } from "../db/recruiters.js";
import {
  insertOutreach, insertUndrafted, selectLastDraftedAt,
  type InsertOutreachInput, type InsertUndraftedInput,
} from "../db/outreach.js";
import type { UndraftedReason } from "../schemas.js";

/** IST (Asia/Kolkata) calendar date for `now`, formatted YYYY-MM-DD. Pure. */
export function istDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function readResumeDefault(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

export interface RunOutreachDeps {
  syncContacts: (profileId: string) => Promise<{ manual: number; raw: number }>;
  selectNotifiedPostingsSince: (sinceIso: string, profileId: string) => OutreachNotifiedPosting[];
  selectAllRecruiters: () => RecruiterRow[];
  selectLastDraftedAt: (email: string, profileId: string) => string | null;
  loadTemplate: (path: string) => OutreachTemplate;
  readResume: (path: string) => Buffer | null;
  createDraft: (profileId: string, mime: string) => Promise<CreatedDraft>;
  insertOutreach: (row: InsertOutreachInput) => number;
  insertUndrafted: (row: InsertUndraftedInput) => void;
  now: () => Date;
  attachResume?: boolean;
}

function defaultDeps(): RunOutreachDeps {
  return {
    syncContacts: (profileId: string) => syncContactsFromSheet(profileId),
    selectNotifiedPostingsSince,
    selectAllRecruiters,
    selectLastDraftedAt,
    loadTemplate: loadTemplateDefault,
    readResume: readResumeDefault,
    createDraft: createDraftDefault,
    insertOutreach,
    insertUndrafted,
    now: () => new Date(),
    attachResume: config.outreach.attachResume,
  };
}

export interface RunOutreachOptions {
  profileId: string;
  sinceIso: string;
  runId: number | null;
  deps?: Partial<RunOutreachDeps>;
}

export interface RunOutreachResult {
  draftsCreated: number;
  undrafted: number;
  companiesMatched: number;
}

interface CompanyGroup {
  companyName: string;
  postings: OutreachNotifiedPosting[];
}

function groupByCompany(postings: OutreachNotifiedPosting[]): CompanyGroup[] {
  const order: string[] = [];
  const groups = new Map<string, OutreachNotifiedPosting[]>();
  for (const p of postings) {
    if (!groups.has(p.company)) {
      groups.set(p.company, []);
      order.push(p.company);
    }
    groups.get(p.company)!.push(p);
  }
  return order.map((companyName) => ({ companyName, postings: groups.get(companyName)! }));
}

/** Reason to record on the undrafted row for a company with zero eligible
 *  contacts: 'no_contact' when no candidate matched the company at all, else
 *  the strongest ineligible reason found ('cooldown' beats 'bounced_contact'
 *  when both are present in the matched pool). */
function undraftedReasonFor(ineligible: Array<{ reason: IneligibleReason }>): UndraftedReason {
  if (ineligible.length === 0) return "no_contact";
  return ineligible.some((i) => i.reason === "cooldown") ? "cooldown" : "bounced_contact";
}

export async function runOutreach(options: RunOutreachOptions): Promise<RunOutreachResult> {
  const deps: RunOutreachDeps = { ...defaultDeps(), ...options.deps };
  const { profileId, sinceIso, runId } = options;

  await deps.syncContacts(profileId);

  const allNotified = deps.selectNotifiedPostingsSince(sinceIso, profileId);
  const draftSeverities = new Set(config.outreach.draftSeverities);
  const eligiblePostings = allNotified.filter((p) => draftSeverities.has(p.severity));

  const template = deps.loadTemplate(config.outreach.templatePath);
  const candidates = deps.selectAllRecruiters();
  const now = deps.now();
  const nowMs = now.getTime();
  const runDate = istDate(now);
  const senderName = profile.senderName ?? profile.id ?? "default";
  const profilePitch = profile.profilePitch ?? null;
  const senderLinks = profile.senderLinks ?? [];
  const attachResume = deps.attachResume ?? true;

  let resumeBuffer: Buffer | null = null;
  let resumeWarned = false;
  function resolveResumeAttachment(): { filename: string; mimeType: string; content: Buffer } | undefined {
    if (!attachResume) return undefined;
    if (resumeBuffer === null && !resumeWarned) {
      resumeBuffer = deps.readResume(resumePdfPath);
      if (resumeBuffer === null) {
        resumeWarned = true;
        logger.warn({ resumePdfPath }, "outreach: resume file missing; sending drafts without attachment");
      }
    }
    if (resumeBuffer === null) return undefined;
    return { filename: `${senderName} Resume.pdf`, mimeType: "application/pdf", content: resumeBuffer };
  }

  let draftsCreated = 0;
  let undraftedCount = 0;
  let companiesMatched = 0;

  for (const group of groupByCompany(eligiblePostings)) {
    const { eligible, ineligible } = findContacts({
      companyName: group.companyName,
      candidates,
      lastDraftedAt: (email: string) => deps.selectLastDraftedAt(email, profileId),
      nowMs,
      cooldownDays: config.outreach.cooldownDays,
    });

    if (eligible.length > 0) companiesMatched++;

    const roles = group.postings.map((p) => ({
      title: p.jobTitle,
      jobUrl: p.jobUrl,
      severity: p.severity,
      score: p.llmConfidence,
    }));

    if (eligible.length === 0) {
      const reason = undraftedReasonFor(ineligible);
      for (const p of group.postings) {
        deps.insertUndrafted({
          profileId,
          runId,
          runDate,
          company: group.companyName,
          jobTitle: p.jobTitle,
          location: p.location,
          jobUrl: p.jobUrl,
          severity: p.severity,
          score: p.llmConfidence,
          reason,
        });
        undraftedCount++;
      }
      continue;
    }

    for (const recruiter of eligible) {
      const rendered = renderDraft({
        template,
        contactName: recruiter.contactName,
        company: group.companyName,
        roles: group.postings.map((p) => ({ title: p.jobTitle, jobUrl: p.jobUrl })),
        senderName,
        profilePitch,
        senderLinks,
      });

      const mime = buildDraftMime({
        to: recruiter.email,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        attachment: resolveResumeAttachment(),
      });

      try {
        const created = await deps.createDraft(profileId, mime);
        deps.insertOutreach({
          profileId,
          recruiterEmail: recruiter.email,
          companyName: group.companyName,
          rolesJson: JSON.stringify(roles),
          runId,
          runDate,
          gmailDraftId: created.draftId,
          gmailThreadId: created.threadId,
          gmailMessageId: created.messageId,
          status: "draft",
          draftedAt: now.toISOString(),
          sentAt: null,
          verifiedAt: null,
          lastCheckedAt: null,
          failureDetail: null,
        });
        draftsCreated++;
      } catch (err) {
        if (err instanceof GoogleAuthExpiredError) throw err;
        logger.error(
          { err: String(err), company: group.companyName, recruiter: recruiter.email },
          "outreach: draft creation failed; continuing with remaining contacts",
        );
      }
    }
  }

  return { draftsCreated, undrafted: undraftedCount, companiesMatched };
}
