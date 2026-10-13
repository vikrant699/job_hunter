import type { Caught } from "../util/errorCause.js";

export function thrownBy<T>(fn: () => T): Caught {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned");
}

export async function rejectionOf<T>(promise: Promise<T>): Promise<Caught> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
