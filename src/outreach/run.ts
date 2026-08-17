import { existsSync, readFileSync } from "node:fs";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { profile, resumePdfPath } from "../profile.js";
import { syncContactsFromSheet } from "./contacts.js";
import { findContacts, normalizeCompanyName } from "./match.js";
import type { IneligibleReason } from "./match.js";
import { loadTemplate as loadTemplateDefault, renderDraft } from "./template.js";
import type { OutreachTemplate } from "./template.js";
import { buildDraftMime } from "../google/mime.js";
import { createDraft as createDraftDefault } from "../google/gmail.js";
import type { CreatedDraft } from "../google/gmail.js";
import { GoogleAuthExpiredError } from "../google/auth.js";
import { selectNotifiedPostingsSince } from "../db/postings.js";
import type { OutreachNotifiedPosting } from "../db/postings.js";
import { selectAllRecruiters } from "../db/recruiters.js";
import type { RecruiterRow } from "../db/recruiters.js";
import { insertOutreach, insertUndrafted, selectLastDraftedAt } from "../db/outreach.js";
import type { InsertOutreachInput, InsertUndraftedInput } from "../db/outreach.js";
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

/** Groups by normalized company name so near-duplicate registry entries ("Wipro" vs "Wipro Limited")
 *  don't produce two drafts to the same recruiter; display name is the first spelling seen. */
export function groupByCompany(postings: OutreachNotifiedPosting[]): CompanyGroup[] {
  const byKey = new Map<string, CompanyGroup>();
  const order: CompanyGroup[] = [];
  for (const p of postings) {
    const key = normalizeCompanyName(p.company);
    const existing = byKey.get(key);
    if (existing) existing.postings.push(p);
    else {
      const group = { companyName: p.company, postings: [p] };
      byKey.set(key, group);
      order.push(group);
    }
  }
  return order;
}

/** 'no_contact' if nothing matched; else the strongest ineligible reason ('cooldown' beats 'bounced_contact'). */
function undraftedReasonFor(ineligible: Array<{ reason: IneligibleReason }>): UndraftedReason {
  if (ineligible.length === 0) return "no_contact";
  return ineligible.some((i) => i.reason === "cooldown") ? "cooldown" : "bounced_contact";
}

export async function runOutreach(options: RunOutreachOptions): Promise<RunOutreachResult> {
  const deps: RunOutreachDeps = { ...defaultDeps(), ...options.deps };
  const { profileId, sinceIso, runId } = options;

  // profileId selects the Gmail token; sender identity comes from the loaded profile module - must match.
  const loadedProfileId = profile.id ?? "default";
  if (profileId !== loadedProfileId) {
    throw new Error(
      `outreach: profileId "${profileId}" does not match the loaded profile "${loadedProfileId}" ` +
        `— run with --profile ${profileId} so identity and Gmail token agree`,
    );
  }

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
  // Tracks in-run duplicates: two different companies can resolve to the same recruiter
  // (alt-name matches), and the in-DB cooldown only reflects pre-run state.
  const draftedThisRun = new Set<string>();

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
      if (draftedThisRun.has(recruiter.email)) {
        logger.info(
          { recruiter: recruiter.email, company: group.companyName },
          "outreach: already drafted this run for another company; skipping",
        );
        continue;
      }

      const rendered = renderDraft({
        template,
        contactName: recruiter.contactName,
        company: group.companyName,
        roles: group.postings.map((p) => ({ title: p.jobTitle, jobUrl: p.jobUrl })),
        senderName,
        profilePitch,
        senderLinks,
      });

      const attachment = resolveResumeAttachment();
      const mime = buildDraftMime({
        to: recruiter.email,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        ...(attachment !== undefined ? { attachment } : {}),
      });

      let created: CreatedDraft;
      try {
        created = await deps.createDraft(profileId, mime);
      } catch (err) {
        if (err instanceof GoogleAuthExpiredError) throw err;
        logger.error(
          { err: String(err), company: group.companyName, recruiter: recruiter.email },
          "outreach: draft creation failed; continuing with remaining contacts",
        );
        continue;
      }
      // Record before the DB write so a failed insert can't lead to a second draft to the same person.
      draftedThisRun.add(recruiter.email);

      try {
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
        // Draft exists in Gmail but has no DB row (no cooldown, absent from Drafts tab); log loudly to reconcile.
        logger.error(
          {
            err: String(err), company: group.companyName, recruiter: recruiter.email,
            gmailDraftId: created.draftId,
          },
          "outreach: ORPHAN DRAFT — created in Gmail but DB record failed; not tracked on the sheet",
        );
      }
    }
  }

  return { draftsCreated, undrafted: undraftedCount, companiesMatched };
}
