// Thrown when the LLM backend is unreachable or misconfigured; callers re-throw rather than
// swallowing it as a per-posting gate-error, so the run aborts instead of churning bogus 0-scores.
// Own module so the transport can throw it without importing client.ts (which imports it).
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
