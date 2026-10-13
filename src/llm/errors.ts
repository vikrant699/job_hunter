// Callers re-throw instead of swallowing it as a per-posting gate-error, so the run aborts rather than churning 0-scores.
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
