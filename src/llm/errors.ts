/**
 * Thrown when the LLM backend is unreachable or misconfigured — distinct from a
 * per-posting gate/extract failure. Callers (pipeline, scheduler) re-throw this
 * instead of swallowing it as a "gate-error", so the run aborts loudly rather
 * than churning thousands of bogus 0-scores against a dead backend.
 *
 * Lives in its own module so both transports can throw it without importing
 * client.ts (which imports them).
 */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
