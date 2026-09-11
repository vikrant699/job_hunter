import type { Caught } from "../util/errorCause.js";

/** Runs `fn` and hands back what it threw; fails the test if it returned. */
export function thrownBy<T>(fn: () => T): Caught {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

/** Awaits `promise` and hands back its rejection; fails the test if it resolved. */
export async function rejectionOf<T>(promise: Promise<T>): Promise<Caught> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
