// One-bit channel between db.ts and sync.ts: sync.ts can't import db.ts to check if the DB is open (that import would open it),
// so this dependency-free module just records the fact; pullDb refuses to swap the file while it's set.
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
