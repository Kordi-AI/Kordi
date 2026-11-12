import { CloudAuthError } from './cloudAuthError';

export function cloudSyncCursorRequiresFallback(
  previousCursor: string,
  nextCursor: string,
  hasMore: boolean,
): boolean {
  // Chat cursors are opaque, signed, and account-bound. Clients must never
  // parse or order them; only a non-advancing paginated response is invalid.
  if (!nextCursor.trim()) return true;
  return hasMore && nextCursor === previousCursor;
}

/**
 * True only when `GET /v2/chat/sync` says the saved cursor can no longer be
 * used: `409 SYNC_CURSOR_EXPIRED`, or any response carrying
 * `details.bootstrap_required`. A network error, a timeout or another server
 * error keeps the cursor, and the catch-up is retried from it.
 */
export function chatSyncCursorExpired(
  error: unknown,
  status: number | null = error instanceof CloudAuthError ? error.status : null,
): boolean {
  if (error instanceof CloudAuthError && (error.serverCode === 'SYNC_CURSOR_EXPIRED' || error.bootstrapRequired)) {
    return true;
  }
  // The sync route answers 409 for nothing else.
  return status === 409;
}
