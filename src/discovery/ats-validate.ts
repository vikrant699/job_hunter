import { z } from "zod";
import { atsFetchJson, atsFetchText } from "../ats/http.js";
import { extractKekaOrgGuid, kekaEmbedUrl } from "../ats/keka.js";
import { phenomAdapter } from "../ats/phenom.js";
import { darwinboxAdapter } from "../ats/darwinbox.js";
import { greythrAdapter } from "../ats/greythr.js";
import type { AdapterCompany } from "../types.js";
import { safeUrl, firstPathSegment } from "./ats-patterns.js";
import type { AtsCandidate } from "./ats-patterns.js";

export interface ValidateResult {
  ok: boolean;
  total: number | null;
  error: string | null;
}

const GreenhouseResponseSchema = z.object({
  jobs: z.array(z.unknown()).optional(),
  meta: z.object({ total: z.number().optional() }).optional(),
});

const AshbyResponseSchema = z.object({
  jobs: z.array(z.unknown()).optional(),
});

const WorkdayResponseSchema = z.object({
  total: z.number().optional(),
});

const SmartRecruitersResponseSchema = z.object({
  totalFound: z.number().optional(),
  content: z.array(z.unknown()).optional(),
});

const RecruiteeResponseSchema = z.object({
  offers: z.array(z.unknown()).optional(),
});

const WorkableResponseSchema = z.object({
  jobs: z.array(z.unknown()).optional(),
});

export interface KekaMeta {
  orgGuid: string;
  total: number;
}

/**
 * Keka can't be validated from the slug alone — the embed API needs the org
 * GUID that sits in the careers-page HTML. Fetch the page, extract the GUID,
 * then confirm the embed API answers with a job array. Null on any failure;
 * the caller falls back to llm-scrape.
 */
export async function discoverKekaMeta(c: AtsCandidate): Promise<KekaMeta | null> {
  try {
    const html = await atsFetchText(c.url, { provider: "keka" });
    const orgGuid = extractKekaOrgGuid(html);
    if (!orgGuid) return null;
    const raw = await atsFetchJson(kekaEmbedUrl(c.slug, orgGuid), { provider: "keka" });
    if (!Array.isArray(raw)) return null;
    return { orgGuid, total: raw.length };
  } catch {
    return null;
  }
}

/**
 * Probe a single candidate. Returns {ok, total} where total is the posting
 * count if the provider exposes one. Providers without a public validator
 * always return {ok: false, error: "no validator"} — callers should still
 * treat the *detection* as useful evidence.
 */
export async function validateCandidate(c: AtsCandidate): Promise<ValidateResult> {
  try {
    switch (c.provider) {
      case "greenhouse": {
        const raw = await atsFetchJson(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs?content=false`,
          { provider: "greenhouse" }
        );
        const data = GreenhouseResponseSchema.parse(raw);
        const total = data.meta?.total ?? data.jobs?.length ?? 0;
        return { ok: Array.isArray(data.jobs), total, error: null };
      }
      case "lever": {
        const raw = await atsFetchJson(
          `https://api.lever.co/v0/postings/${encodeURIComponent(c.slug)}?mode=json&limit=1`,
          { provider: "lever" }
        );
        if (!Array.isArray(raw)) return { ok: false, total: null, error: "not array" };
        // limit=1 caps the returned slice — we don't get a "total" cheaply. Treat
        // any non-empty board as ok and report what we got back.
        return { ok: true, total: raw.length, error: null };
      }
      case "ashby": {
        const raw = await atsFetchJson(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}?includeCompensation=false`,
          { provider: "ashby" }
        );
        const data = AshbyResponseSchema.parse(raw);
        return {
          ok: Array.isArray(data.jobs),
          total: data.jobs?.length ?? 0,
          error: null,
        };
      }
      case "workday": {
        // c.url is the tenant URL; reuse the workday-probe path.
        const u = safeUrl(c.url);
        if (!u) return { ok: false, total: null, error: "bad url" };
        const tenant = u.host.split(".")[0];
        const site = firstPathSegment(u);
        if (!tenant || !site) return { ok: false, total: null, error: "malformed" };
        const cxsUrl = `${u.protocol}//${u.host}/wday/cxs/${tenant}/${site}/jobs`;
        const raw = await atsFetchJson(
          cxsUrl,
          {
            method: "POST",
            body: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" },
            provider: "workday",
          }
        );
        const data = WorkdayResponseSchema.parse(raw);
        return { ok: true, total: data.total ?? null, error: null };
      }
      case "smartrecruiters": {
        const raw = await atsFetchJson(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.slug)}/postings?limit=1`,
          { provider: "smartrecruiters" }
        );
        const data = SmartRecruitersResponseSchema.parse(raw);
        return {
          ok: typeof data.totalFound === "number" || Array.isArray(data.content),
          total: data.totalFound ?? data.content?.length ?? 0,
          error: null,
        };
      }
      case "recruitee": {
        const raw = await atsFetchJson(
          `${c.url}/api/offers/`,
          { provider: "recruitee" }
        );
        const data = RecruiteeResponseSchema.parse(raw);
        return {
          ok: Array.isArray(data.offers),
          total: data.offers?.length ?? 0,
          error: null,
        };
      }
      case "workable": {
        const raw = await atsFetchJson(
          `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(c.slug)}?details=false`,
          { provider: "workable" }
        );
        const data = WorkableResponseSchema.parse(raw);
        return { ok: Array.isArray(data.jobs), total: data.jobs?.length ?? 0, error: null };
      }
      case "phenom": {
        const company: AdapterCompany = {
          provider: "phenom",
          slug: c.slug,
          name: c.slug,
          careersUrl: c.url,
          tenantUrl: c.url,
          apiMeta: null,
        };
        const postings = await phenomAdapter.listPostings(company);
        return { ok: true, total: postings.length, error: null };
      }
      case "darwinbox": {
        const company: AdapterCompany = {
          provider: "darwinbox",
          slug: c.slug,
          name: c.slug,
          careersUrl: c.url,
          tenantUrl: c.url,
          apiMeta: null,
        };
        const postings = await darwinboxAdapter.listPostings(company);
        return { ok: true, total: postings.length, error: null };
      }
      case "greythr": {
        const company: AdapterCompany = {
          provider: "greythr",
          slug: c.slug,
          name: c.slug,
          careersUrl: c.url,
          tenantUrl: c.url,
          apiMeta: null,
        };
        const postings = await greythrAdapter.listPostings(company);
        return { ok: true, total: postings.length, error: null };
      }
      default:
        return { ok: false, total: null, error: "no validator" };
    }
  } catch (err) {
    return { ok: false, total: null, error: String(err).slice(0, 120) };
  }
}
