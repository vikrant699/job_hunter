import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

export interface AtsAdapter {
  provider: Provider;

  // Populate jdText when the listing returns the body; otherwise leave empty and implement fetchJd.
  listPostings(company: AdapterCompany): Promise<NormalizedPosting[]>;

  // Failure convention: return "" (warn-logging) on a malformed detail response so the pipeline stores "no-jd"; reserve throwing for transport errors.
  // May refine posting.location (ralphlauren, via lateLocationCheck) and posting.jobUrl (smartrecruiters); other fields aren't part of the contract.
  fetchJd?(company: AdapterCompany, posting: NormalizedPosting): Promise<string>;
}
