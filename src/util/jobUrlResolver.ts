// Resolves a job posting URL (typically pasted while debugging "why isn't this in my sheet")
// into an ATS provider + slug hint + external id, matching the URL shapes our OWN adapters
// build into postings.job_url (see the per-provider comments below — each cites the adapter
// function that constructs the URL). Pure and side-effect free; scripts/probeUrl.ts is the
// only caller.

export interface JobUrlResolution {
  provider: string | null;
  slugHint: string | null;
  externalId: string | null;
  /** Present when the match is ambiguous, needs registry lookup by host, or the URL's id is
   *  known to differ from what we store as postings.external_id (a job_url LIKE fallback is
   *  then the right next move, not an exact (provider, external_id) lookup). */
  hint?: string;
}

interface UrlMatch {
  provider: string | null;
  slugHint: string | null;
  externalId: string | null;
  hint?: string;
}

interface UrlMatcher {
  readonly name: string;
  readonly match: (url: URL) => UrlMatch | null;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((s) => s !== "");
}

function firstLabel(host: string): string | null {
  return host.split(".")[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MATCHERS: UrlMatcher[] = [
  {
    // greenhouse.ts normalize(): jobUrl = j.absolute_url, e.g. "https://boards.greenhouse.io/<slug>/jobs/<id>"
    // or the newer "https://job-boards.greenhouse.io/<slug>/jobs/<id>"; externalId = String(j.id), same id.
    name: "greenhouse",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (host !== "boards.greenhouse.io" && host !== "job-boards.greenhouse.io") return null;
      const segs = pathSegments(url);
      const idx = segs.indexOf("jobs");
      if (idx < 1) return null;
      const slug = segs[idx - 1];
      const id = segs[idx + 1];
      if (!slug || !id) return null;
      return { provider: "greenhouse", slugHint: slug, externalId: id };
    },
  },
  {
    // lever.ts normalize(): jobUrl = j.hostedUrl, "https://jobs.lever.co/<slug>/<uuid>"; externalId = j.id, the same uuid.
    name: "lever",
    match(url) {
      if (url.hostname.toLowerCase() !== "jobs.lever.co") return null;
      const segs = pathSegments(url);
      const slug = segs[0];
      const id = segs[1];
      if (!slug || !id || !UUID_RE.test(id)) return null;
      return { provider: "lever", slugHint: slug, externalId: id };
    },
  },
  {
    // ashby.ts normalize(): jobUrl = j.jobUrl ?? j.applyUrl, "https://jobs.ashbyhq.com/<slug>/<id>"; externalId = j.id.
    name: "ashby",
    match(url) {
      if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;
      const segs = pathSegments(url);
      const slug = segs[0];
      const id = segs[1];
      if (!slug || !id) return null;
      return { provider: "ashby", slugHint: slug, externalId: id };
    },
  },
  {
    // smartrecruiters.ts srPostingUrl(): "https://jobs.smartrecruiters.com/<Company>/<id>-<title-slug>"
    // (or bare "<id>" before fetchJd's canonical rewrite); externalId = p.id, the leading digits either way.
    name: "smartrecruiters",
    match(url) {
      if (url.hostname.toLowerCase() !== "jobs.smartrecruiters.com") return null;
      const segs = pathSegments(url);
      const company = segs[0];
      const last = segs[1];
      if (!company || !last) return null;
      const id = /^(\d+)/.exec(last)?.[1];
      if (!id) return null;
      return { provider: "smartrecruiters", slugHint: company, externalId: id };
    },
  },
  {
    // workday.ts normalizeWorkdayListing(): jobUrl = "<uiBase><externalPath>", e.g.
    // ".../en-US/External/job/Bengaluru---Karnataka/Software-Engineer_R12345". The requisition
    // segment (last path segment after "/job/") ends in the numeric-suffixed slug, but the
    // DB's externalId is shortId/jobPostingId (e.g. "R12345") which is usually a DIFFERENT
    // string than this URL segment — an exact (provider, external_id) lookup will likely miss.
    name: "workday",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".myworkdayjobs.com")) return null;
      const tenant = firstLabel(host);
      const segs = pathSegments(url);
      const jobIdx = segs.indexOf("job");
      let externalId: string | null = null;
      if (jobIdx >= 0 && jobIdx < segs.length - 1) {
        externalId = segs[segs.length - 1] ?? null;
      }
      return {
        provider: "workday",
        slugHint: tenant,
        externalId,
        hint:
          "workday's stored external_id (shortId/jobPostingId, e.g. \"R12345\") is usually not " +
          "the same string as this URL's trailing requisition slug (e.g. \"Software-Engineer_R12345\") " +
          "— an exact (provider, external_id) lookup will likely miss; fall back to a job_url LIKE lookup.",
      };
    },
  },
  {
    // keka.ts normalizeKeka(): jobUrl = "https://<tenant>.keka.com/careers/jobdetails/<id>"; externalId = String(j.id).
    name: "keka",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".keka.com")) return null;
      const id = /^\/careers\/jobdetails\/([^/?#]+)/i.exec(url.pathname)?.[1];
      if (!id) return null;
      return { provider: "keka", slugHint: firstLabel(host), externalId: id };
    },
  },
  {
    // darwinbox.ts darwinboxJobUrl(): both generations (candidatev2 AND legacy) are stored as
    // ".../ms/candidatev2/<token>/careers/jobDetails/<id>"; externalId = String(j.id), same id.
    // A "<tenant>.darwinbox.../careers/<id>" URL (no jobDetails segment) is what the LIVE legacy
    // "candidate ms" UI renders in a browser, but our adapter never stores that shape — treat it
    // as a same-id alias and fall back to a LIKE lookup if the exact URL isn't found.
    name: "darwinbox",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".darwinbox.in") && !host.endsWith(".darwinbox.com")) return null;
      const tenant = firstLabel(host);
      const v2Id = /\/jobDetails\/([0-9a-zA-Z]+)/i.exec(url.pathname)?.[1];
      if (v2Id) return { provider: "darwinbox", slugHint: tenant, externalId: v2Id };
      const legacyId = /\/careers\/([0-9a-zA-Z]+)(?:[/?#]|$)/i.exec(url.pathname)?.[1];
      if (!legacyId) return null;
      return {
        provider: "darwinbox",
        slugHint: tenant,
        externalId: legacyId,
        hint:
          "legacy candidate-ms careers/<id> shape; our adapter always stores postings under the " +
          "candidatev2 jobDetails URL shape (same id) — if the exact URL isn't found, fall back to " +
          "a job_url LIKE lookup on the id.",
      };
    },
  },
  {
    // zohorecruit.ts zohoJobUrl(): "<careersUrl>/<id>/<title-slug>" (or bare "<id>" with no title);
    // externalId = j.id, the trailing numeric segment.
    name: "zohorecruit",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".zohorecruit.com") && !host.endsWith(".zohorecruit.in")) return null;
      const numeric = pathSegments(url).filter((s) => /^\d+$/.test(s));
      const id = numeric[numeric.length - 1] ?? null;
      return { provider: "zohorecruit", slugHint: firstLabel(host), externalId: id };
    },
  },
  {
    // freshteam.ts parseFreshteamList(): jobUrl from a "/jobs/<id>/<slug>" href; externalId = id.
    name: "freshteam",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".freshteam.com")) return null;
      const segs = pathSegments(url);
      if (segs[0] !== "jobs") return null;
      const id = segs[1];
      if (!id) return null;
      return { provider: "freshteam", slugHint: firstLabel(host), externalId: id };
    },
  },
  {
    // oracle.ts normalizeOracle(): jobUrl = "<base>/hcmUI/CandidateExperience/en/sites/<site>/job/<id>"; externalId = r.Id.
    name: "oracle",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.includes(".oraclecloud.com")) return null;
      const id = /\/job\/([^/?#]+)/i.exec(url.pathname)?.[1];
      if (!id) return null;
      return { provider: "oracle", slugHint: host, externalId: id };
    },
  },
  {
    // eightfold.ts normalizeEightfold(): jobUrl = p.canonicalPositionUrl (vendor-supplied, may carry
    // ?pid=<id>) or our own "https://<host>/careers/job/<id>" fallback; externalId = String(p.id).
    name: "eightfold",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".eightfold.ai")) return null;
      const tenant = firstLabel(host);
      const pathId = /\/careers\/job\/([^/?#]+)/i.exec(url.pathname)?.[1];
      if (pathId) return { provider: "eightfold", slugHint: tenant, externalId: pathId };
      const pid = url.searchParams.get("pid");
      if (!pid) return null;
      return {
        provider: "eightfold",
        slugHint: tenant,
        externalId: pid,
        hint:
          "canonicalPositionUrl comes straight from eightfold's own API, not something we synthesize " +
          "— if the exact (provider, external_id) lookup misses, fall back to a job_url LIKE lookup.",
      };
    },
  },
  {
    // bamboohr.ts bambooHrJobUrl(): "https://<tenant>.bamboohr.com/careers/<id>"; externalId = String(j.id).
    name: "bamboohr",
    match(url) {
      const host = url.hostname.toLowerCase();
      if (!host.endsWith(".bamboohr.com")) return null;
      const segs = pathSegments(url);
      if (segs[0] !== "careers") return null;
      const id = segs[1];
      if (!id || id === "list") return null;
      return { provider: "bamboohr", slugHint: firstLabel(host), externalId: id };
    },
  },
  {
    // A company's OWN careers page embedding a Greenhouse widget links out via ?gh_jid=<id> rather
    // than a boards.greenhouse.io URL. Not something our greenhouse adapter stores (it always uses
    // the boards-api absolute_url), but common in a URL copied straight from a browser.
    name: "greenhouse-embedded",
    match(url) {
      const jid = url.searchParams.get("gh_jid");
      if (!jid) return null;
      return {
        provider: "greenhouse",
        slugHint: null,
        externalId: jid,
        hint: "embedded greenhouse board; company resolved by host from the registry",
      };
    },
  },
  {
    // sfcsb.ts sfcsbJobUrl(): ".../job/<slug>/<id>-<locale>/"; successfactors.ts's search-result hrefs:
    // ".../job/<slug>/<reqId>/" (reqId recognized here only when purely numeric). Both are SAP
    // SuccessFactors engines on the company's own domain — no shared host to key off, and two
    // different adapters (sfcsb.ts / successfactors.ts) can produce this shape, so the provider
    // is left null for the CLI to resolve by host against the registry.
    name: "successfactors-shaped",
    match(url) {
      const id = /\/job\/[^/]+\/(\d+)(?:-[^/]+)?\/?$/i.exec(url.pathname)?.[1];
      if (!id) return null;
      return {
        provider: null,
        slugHint: url.hostname.toLowerCase(),
        externalId: id,
        hint: "successfactors-shaped URL (sfcsb or successfactors); resolve by host against the registry",
      };
    },
  },
] as const;

/** Resolve a pasted job posting URL to an ATS provider + slug hint + external id (best-effort,
 *  pattern-matched — never throws). `hint` explains an ambiguity or a known id-shape mismatch. */
export function resolveJobUrl(raw: string): JobUrlResolution {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { provider: null, slugHint: null, externalId: null, hint: "not a valid URL" };
  }

  for (const matcher of MATCHERS) {
    const result = matcher.match(url);
    if (result) return result;
  }

  return {
    provider: null,
    slugHint: null,
    externalId: null,
    hint: "unrecognized URL shape; no known ATS pattern matched",
  };
}
