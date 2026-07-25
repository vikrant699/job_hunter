import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";

export interface AtsAdapter {
  provider: Provider;

  /**
   * Return every posting for one company. Each result must have a stable
   * `externalId`. Populate `jdText` here if the listing endpoint already
   * returns the body (Greenhouse/Lever/Ashby); otherwise leave it empty
   * and implement `fetchJd`.
   */
  listPostings(company: AdapterCompany): Promise<NormalizedPosting[]>;

  /**
   * Fetch the JD body for one posting. The pipeline calls this only for
   * postings that survived location + dedup, so we don't pay the HTTP cost
   * for postings we'd skip.
   *
   * Failure convention: PREFER returning "" (and warn-logging) when the detail
   * response is malformed - the pipeline stores the posting with drop_stage
   * "no-jd". Throwing is also tolerated (the pipeline counts it jdFetchFailed
   * and skips the posting) but reserve it for transport errors.
   *
   * A fetchJd MAY refine the posting in place when the detail page carries
   * better data: posting.location (ralphlauren - the pipeline re-checks
   * location AFTER fetchJd via lateLocationCheck) and posting.jobUrl
   * (smartrecruiters - canonical apply URL). Refining other fields is not
   * part of the contract.
   */
  fetchJd?(company: AdapterCompany, posting: NormalizedPosting): Promise<string>;
}
