import type { AdapterCompany, NormalizedPosting, Provider } from "../types.js";

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
   */
  fetchJd?(company: AdapterCompany, posting: NormalizedPosting): Promise<string>;
}
