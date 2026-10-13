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

// Exact-token match after splitting on comma/dash/underscore/whitespace/period/brackets - NEVER a substring test, which would select "Indiana"/"Indianapolis" leaves (live false-positives on 7 US tenants); covers "Ahmedabad, Gujarat, India", "India - Chennai", "India_Bangalore", "Hyderabad Office, India.".
export function descriptorIsIndia(descriptor: string): boolean {
  return descriptor.split(/[,\-\s.()/|;_]+/).some((t) => t.toLowerCase() === "india");
}

// Leaves that name an Indian city/state/office district without the country ("Regus, Madhapur", "Bangalore Area", "Tamil Nādu"); namesakes elsewhere (Salem, Calcutta OH, Kota) are left out on purpose.
const INDIA_PLACES = [
  "bangalore", "bengaluru", "mumbai", "bombay", "navi mumbai", "thane", "hyderabad", "secunderabad", "pune", "chennai", "madras",
  "delhi", "new delhi", "noida", "greater noida", "gurgaon", "gurugram", "faridabad", "ghaziabad", "kolkata", "ahmedabad",
  "gandhinagar", "vadodara", "baroda", "surat", "rajkot", "coimbatore", "kochi", "cochin", "ernakulam", "trivandrum",
  "thiruvananthapuram", "kozhikode", "calicut", "jaipur", "udaipur", "jodhpur", "chandigarh", "mohali", "panchkula", "ludhiana",
  "amritsar", "jalandhar", "indore", "bhopal", "jabalpur", "gwalior", "nagpur", "nashik", "aurangabad", "kolhapur", "satara",
  "mysore", "mysuru", "mangalore", "mangaluru", "hubli", "hubballi", "dharwad", "belgaum", "belagavi", "tumkur", "tumakuru",
  "manipal", "udupi", "visakhapatnam", "vizag", "vijayawada", "guntur", "nellore", "tirupati", "warangal", "bhubaneswar",
  "cuttack", "lucknow", "kanpur", "varanasi", "meerut", "patna", "ranchi", "jamshedpur", "guwahati", "dehradun", "haridwar",
  "rudrapur", "pantnagar", "baddi", "madurai", "tiruchirappalli", "trichy", "vellore", "erode", "tiruppur", "tirupur", "hosur",
  "sriperumbudur", "chengalpattu", "manesar", "bawal", "bhiwadi", "neemrana", "sonipat", "panipat", "sanand", "vapi", "dahej",
  "bharuch", "ankleshwar", "halol", "jamnagar", "chakan", "ranjangaon", "pimpri", "chinchwad", "talegaon", "raipur", "goa",
  "panaji", "margao", "verna", "puducherry", "pondicherry", "kalyani", "durgapur", "siliguri", "howrah", "gondia", "ratnagiri",
  "unnao", "mangrol", "sumerpur",
  "karnataka", "maharashtra", "telangana", "tamil nadu", "andhra pradesh", "kerala", "gujarat", "haryana", "uttar pradesh",
  "west bengal", "rajasthan", "punjab", "odisha", "orissa", "madhya pradesh", "jharkhand", "bihar", "assam", "chhattisgarh",
  "uttarakhand", "himachal pradesh",
  "madhapur", "gachibowli", "hitec city", "hitech city", "kondapur", "nanakramguda", "raidurg", "whitefield", "manyata",
  "electronic city", "electronics city", "marathahalli", "bellandur", "koramangala", "indiranagar", "sarjapur", "hebbal",
  "yelahanka", "bagmane", "hinjewadi", "hinjawadi", "kharadi", "magarpatta", "hadapsar", "viman nagar", "yerwada", "baner",
  "powai", "andheri", "goregaon", "vikhroli", "malad", "bandra kurla", "airoli", "lower parel", "worli", "sholinganallur",
  "guindy", "taramani", "perungudi", "siruseri", "ambattur", "porur", "okhla", "gift city", "tidel park", "mindspace",
] as const;

// A namesake's descriptor names its own country ("Hyderabad, Sindh, Pakistan", "Kochi, Japan", Hungary's "Hajdu-Bihar"), a US ZIP ("Calcutta, OH 43920") or a US/Canadian region code ("Delhi, LA (Delhi Plant)", "Store 3005243 Delhi ON"); TN and IN are left out since they also mean Tamil Nadu and India.
const FOREIGN_GUARD = ["pakistan", "bangladesh", "nepal", "sri lanka", "japan", "malaysia", "usa", "us", "united states", "uk", "united kingdom", "canada", "australia", "hajdu bihar"] as const;
const US_ZIP_RE = /\b[A-Z]{2}\s+\d{5}\b/;
const NA_REGION = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TX|UT|VT|VA|WA|WV|WI|WY|ON|BC|AB|QC|MB|NS|NB|PE";
const NA_REGION_RE = new RegExp(`,\\s*(?:${NA_REGION})\\b|\\s(?:${NA_REGION})\\s*$`);
// The ISO-3 code as a site prefix ("IND HYDB 18-23 OB3", "Ind – Blr Sez 1"), suffix ("Bengaluru, IND") or delimited segment ("Field Worker - IND Cx", "Remote (IND)"), never a bare mid-string "US PA IND 324"; bare "IN" is Indiana as often as India.
const IND_CODE_RE = /\bIND\s*$|[-,(]\s*IND\b/;
const IND_PREFIX_RE = /^\s*ind\b/i;

function phraseText(descriptor: string): string {
  const words = descriptor.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");
  return ` ${words.join(" ")} `;
}

export function descriptorIsIndianPlace(descriptor: string): boolean {
  if (IND_PREFIX_RE.test(descriptor) || IND_CODE_RE.test(descriptor)) return true;
  if (US_ZIP_RE.test(descriptor) || NA_REGION_RE.test(descriptor)) return false;
  const text = phraseText(descriptor);
  const has = (phrase: string): boolean => text.includes(` ${phrase} `);
  return INDIA_PLACES.some(has) && !FOREIGN_GUARD.some(has);
}

interface Candidate {
  facet: DiscoveredFacet;
  countryLevel: boolean;
  postings: number;
}

// Walks the facet tree (flat and nested shapes) collecting every facet with India leaves.
function collectIndiaFacets(node: JsonValue, out: Candidate[]): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;

  // `nodeId` (the facet-node's own id) is a fallback only used when the node has no explicit facetParameter - distinct from the leaf value id below.
  const nodeId = node["id"];
  const paramRaw = node["facetParameter"] ?? nodeId;
  const param = typeof paramRaw === "string" ? paramRaw : null;

  const valuesRaw = node["values"];
  if (!Array.isArray(valuesRaw)) return;

  if (param !== null) {
    const isCountry = /country/i.test(param);
    const looksLocation = isCountry || /location/i.test(param);
    const uuids: string[] = [];
    let postings = 0;
    let bareIndia = false;
    for (const v of valuesRaw) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const descriptor = v["descriptor"];
      const valueId = v["id"];
      if (typeof descriptor !== "string" || typeof valueId !== "string") continue;
      // Oddly-named params (redhat's country facet node id is literally "a") only take a BARE "India" leaf, since token-matching there could select an unrelated text facet.
      const bare = /^\s*india\s*$/i.test(descriptor);
      if (bare) bareIndia = true;
      const hit = isCountry
        ? descriptorIsIndia(descriptor)
        : looksLocation
          ? descriptorIsIndia(descriptor) || descriptorIsIndianPlace(descriptor)
          : bare;
      if (!hit) continue;
      uuids.push(valueId);
      const count = v["count"];
      if (typeof count === "number") postings += count;
    }
    if (uuids.length > 0) out.push({ facet: { param, uuids }, countryLevel: isCountry || (bareIndia && uuids.length === 1), postings });
  }

  for (const v of valuesRaw) collectIndiaFacets(v, out);
}

// A country facet (named so, or whose lone India leaf is bare "India": bristolmyerssquibb's locationHierarchy2) scopes every India posting in one value, so it beats any city/state facet; otherwise the facet whose India leaves cover the most postings wins.
export function findIndiaFacet(data: JsonValue): DiscoveredFacet | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const found: Candidate[] = [];
  for (const key of ["refineFilters", "facets", "filters"] as const) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) collectIndiaFacets(f, found);
  }
  const country = found.find((c) => c.countryLevel);
  if (country) return country.facet;
  let best: Candidate | null = null;
  for (const c of found) if (!best || c.postings > best.postings) best = c;
  return best?.facet ?? null;
}

// Facet pinned explicitly in api_meta (facetParam + facetValueIds), for tenants whose India leaves discovery cannot recognise; null when either key is absent, falling through to discoverIndiaFacet.
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
