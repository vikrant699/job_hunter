import { atsFetchJson } from "./http.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

export interface DiscoveredFacet {
  param: string;
  // Every facet-value id that selects India: one on tenants with a real country facet, several on tenants whose only location facet has composite per-city leaves (hpe exposes 36).
  uuids: string[];
}

interface WorkdayUrlPartsForFacet {
  cxsBase: string;
}

// Exact-token match after splitting on comma/dash/whitespace - NEVER a substring test, which would select "Indiana"/"Indianapolis" leaves (live false-positives on 7 US tenants); covers "Ahmedabad, Gujarat, India", "India - Chennai", "India Remote".
export function descriptorIsIndia(descriptor: string): boolean {
  return descriptor.split(/[,\-\s]+/).some((t) => t.toLowerCase() === "india");
}

// Walks the facet tree (flat and nested shapes) collecting India leaves.
function findIndiaFacetIn(node: JsonValue): DiscoveredFacet | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;

  // `nodeId` (the facet-node's own id) is a fallback only used when the node has no explicit facetParameter - distinct from the leaf value id below.
  const nodeId = node["id"];
  const paramRaw = node["facetParameter"] ?? nodeId;
  const param = typeof paramRaw === "string" ? paramRaw : null;

  const valuesRaw = node["values"];
  if (!Array.isArray(valuesRaw)) return null;

  const looksLocation = param !== null && /country|location/i.test(param);

  if (param !== null) {
    const uuids: string[] = [];
    for (const v of valuesRaw) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const descriptor = v["descriptor"];
      const valueId = v["id"];
      if (typeof descriptor !== "string" || typeof valueId !== "string") continue;
      // Location-ish params take any India-token leaf; oddly-named params (redhat's country facet node id is literally "a") only take a BARE "India" leaf, since token-matching there could select an unrelated text facet.
      if (looksLocation ? descriptorIsIndia(descriptor) : /^\s*india\s*$/i.test(descriptor)) {
        uuids.push(valueId);
      }
    }
    if (uuids.length > 0) return { param, uuids };
  }

  // Recurse into nested facets (each value can itself be a facet group).
  for (const v of valuesRaw) {
    const nested = findIndiaFacetIn(v);
    if (nested) return nested;
  }
  return null;
}

export function findIndiaFacet(data: JsonValue): DiscoveredFacet | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  for (const key of ["refineFilters", "facets", "filters"] as const) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      const found = findIndiaFacetIn(f);
      if (found) return found;
    }
  }
  return null;
}

// Facet pinned explicitly in api_meta (facetParam + facetValueIds), for tenants whose only location facet has city leaves with no "India" token (lowes: a flat `locations` facet whose India leaf is just "Bengaluru"); null when either key is absent, falling through to discoverIndiaFacet.
export function pinnedFacet(apiMeta: Record<string, string> | null | undefined): DiscoveredFacet | null {
  const param = apiMeta?.facetParam;
  const idsRaw = apiMeta?.facetValueIds;
  if (!param || !idsRaw) return null;
  const uuids = idsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return uuids.length > 0 ? { param, uuids } : null;
}

export async function discoverIndiaFacet(parts: WorkdayUrlPartsForFacet): Promise<DiscoveredFacet | null> {
  const raw = await atsFetchJson(`${parts.cxsBase}/jobs`, {
    method: "POST",
    body: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" },
    provider: "workday",
  });
  const data = JsonValueSchema.parse(raw);
  return findIndiaFacet(data);
}
