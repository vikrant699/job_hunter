// src/db/openState.ts - a one-bit channel between db.ts and sync.ts.
//
// sync.ts replaces data/job_hunter.db wholesale, which is only safe while nobody
// holds an open handle on it. It cannot ask db.ts directly: importing db.ts is
// what opens the handle, so the question would change the answer.
//
// Hence this module, which imports nothing and merely records the fact. db.ts
// sets the bit when it opens the singleton; pullDb refuses to swap when it is
// set. That converts a genuinely platform-dependent bug into one explicit error:
// on Windows the rename fails with EPERM, while on Linux it succeeds and the
// already-open handle keeps reading the REPLACED file - a stale run that then
// pushes its stale state back over the good copy.
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
