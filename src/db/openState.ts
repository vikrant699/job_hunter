// Dependency-free: sync.ts can't import db.ts to check if it's open, since that import opens it.
let opened = false;

export function markDbOpened(): void {
  opened = true;
}

export function markDbClosed(): void {
  opened = false;
}

export function isDbOpen(): boolean {
  return opened;
}
