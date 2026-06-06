/** A counting semaphore whose ceiling is read live (so config changes apply). */
export function makeSemaphore(getLimit: () => number): () => Promise<() => void> {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const release = () => {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  };
  return function acquire(): Promise<() => void> {
    if (inFlight < getLimit()) {
      inFlight++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      waiters.push(() => { inFlight++; resolve(release); });
    });
  };
}
