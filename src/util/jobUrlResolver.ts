export interface JobUrlResolution {
  provider: string | null;
  slugHint: string | null;
  externalId: string | null;
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
    // Workday job URLs end in "/job/<location>/<title-slug>_<requisitionId>"; that id usually differs from the stored externalId.
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
    // Our adapter stores the "careers/jobDetails/<id>" shape; a legacy "careers/<id>" URL is the browser UI's shape with the same id.
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
    // eightfold job URLs are either our own "/careers/job/<id>" or the vendor's canonicalPositionUrl carrying "?pid=<id>".
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
    // A company's own page embedding a Greenhouse widget links out via "?gh_jid=<id>" instead of a boards.greenhouse.io URL.
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
    // sfcsb and successfactors both produce ".../job/<slug>/<numeric id>[-<locale>]/" on the company's own domain, so provider is left null.
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
