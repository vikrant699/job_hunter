import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

export interface AtsAdapter {
  provider: Provider;

  // Populate jdText here if the listing endpoint already returns the body (Greenhouse/Lever/Ashby); otherwise leave it empty and implement fetchJd.
  listPostings(company: AdapterCompany): Promise<NormalizedPosting[]>;

  /** Only called for postings that survived location + dedup. */
  // Failure convention: return "" (warn-logging) on a malformed detail response - the pipeline stores the posting as "no-jd"; throwing is tolerated (counted jdFetchFailed) but reserve it for transport errors.
  // May refine the posting in place: posting.location (ralphlauren, re-checked via lateLocationCheck) and posting.jobUrl (smartrecruiters, canonical apply URL) - other fields aren't part of the contract.
  fetchJd?(company: AdapterCompany, posting: NormalizedPosting): Promise<string>;
}
