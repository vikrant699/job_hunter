import { config } from "../src/config.js";
import { probeWithTimeout } from "../src/util/probe.js";

export const ATS_URL_BUILDERS: Record<string, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=false`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=false`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=1`,
};

export async function probeJsonBoard(url: string, timeoutMs = 8_000): Promise<boolean> {
  const res = await probeWithTimeout(url, {
    timeoutMs,
    headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" },
  });
  if (!res.ok) return false;
  if (res.body.length < 10) return false;
  const lc = res.body.slice(0, 200).toLowerCase();
  if (lc.includes("<!doctype") || lc.includes("<html")) return false;
  return true;
}
