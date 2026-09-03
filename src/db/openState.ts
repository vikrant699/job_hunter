// sync.ts can't import db.ts to check if the DB is open (that import would open it), so this dependency-free module records the fact instead.
let opened = false;

/** Called by db.ts immediately after the singleton connection is created. */
export function markDbOpened(): void {
  opened = true;
}

/** Called by db.ts when the connection is deliberately closed before a push. */
export function markDbClosed(): void {
  opened = false;
}

export function isDbOpen(): boolean {
  return opened;
}
