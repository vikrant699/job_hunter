import { atsFetchJson } from "./http.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

export interface DiscoveredFacet {
  param: string;
  uuid: string;
}

interface WorkdayUrlPartsForFacet {
  cxsBase: string;
}

// Walks the facet tree (handles both flat and nested shapes) for an India
// country leaf. Returns the param + UUID needed for appliedFacets.
function findIndiaFacetIn(node: JsonValue): DiscoveredFacet | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;

  // Pick the most specific param name available on THIS node. `nodeId` is the
  // facet-node's own id (e.g. "Country_Region") — a fallback only used when
  // the node has no explicit facetParameter; distinct from the leaf value id
  // (valueId, below) which identifies the specific facet *value* to select.
  const nodeId = node["id"];
  const paramRaw = node["facetParameter"] ?? nodeId;
  const param = typeof paramRaw === "string" ? paramRaw : null;

  const valuesRaw = node["values"];
  if (!Array.isArray(valuesRaw)) return null;

  const looksCountry = param !== null && /country|location/i.test(param);

  // Direct check: any value with descriptor=India that has its own id (leaf value).
  if (looksCountry) {
    for (const v of valuesRaw) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const descriptor = v["descriptor"];
      const valueId = v["id"];
      if (
        typeof descriptor === "string" &&
        typeof valueId === "string" &&
        /^\s*india\s*$/i.test(descriptor)
      ) {
        return { param, uuid: valueId };
      }
    }
  }

  // Recurse into nested facets (each value can itself be a facet group).
  for (const v of valuesRaw) {
    const nested = findIndiaFacetIn(v);
    if (nested) return nested;
  }
  return null;
}

function findIndiaFacet(data: JsonValue): DiscoveredFacet | null {
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

export async function discoverIndiaFacet(parts: WorkdayUrlPartsForFacet): Promise<DiscoveredFacet | null> {
  const raw = await atsFetchJson(`${parts.cxsBase}/jobs`, {
    method: "POST",
    body: { appliedFacets: {}, limit: 1, offset: 0, searchText: "" },
    provider: "workday",
  });
  const data = JsonValueSchema.parse(raw);
  return findIndiaFacet(data);
}
