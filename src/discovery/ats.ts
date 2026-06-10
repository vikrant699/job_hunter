/**
 * Public re-export barrel for ATS detection + validation.
 * Implementation split: ats-patterns.ts (types, PATTERNS, extraction)
 *                       ats-validate.ts (validateCandidate)
 */
export type { AtsProvider, AtsCapability, AtsCandidate, AtsFetchResult } from "./ats-patterns.js";
export { CAPABILITIES, extractAtsCandidates, discoverFromUrl, safeUrl, firstPathSegment } from "./ats-patterns.js";
export type { ValidateResult, KekaMeta } from "./ats-validate.js";
export { validateCandidate, discoverKekaMeta } from "./ats-validate.js";
