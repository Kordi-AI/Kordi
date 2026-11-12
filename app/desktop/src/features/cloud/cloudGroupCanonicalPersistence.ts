import { invokeDesktop, openOrCreateCanonicalSessionFast, removeCanonicalSessionParticipant,
  upsertCanonicalIdentityFast, upsertCanonicalMessageFast } from '@/lib/desktop';
import { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { cachedSessionSnapshot } from './session';

const nativePersistence = { openOrCreateCanonicalSessionFast, removeCanonicalSessionParticipant,
  upsertCanonicalIdentityFast, upsertCanonicalMessageFast };
export type CloudGroupCanonicalPersistence = typeof nativePersistence;

/** Preserve the source scope through every await in one group replay operation. */
export function browserGroupCanonicalPersistence(
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>,
): CloudGroupCanonicalPersistence {
  return {
    openOrCreateCanonicalSessionFast: request => invoke('desktop_canonical_open_or_create_session_fast', { request }),
    removeCanonicalSessionParticipant: request => invoke('desktop_canonical_remove_session_participant', { request }),
    upsertCanonicalIdentityFast: request => invoke('desktop_canonical_upsert_identity_fast', { request }),
    upsertCanonicalMessageFast: request => invoke('desktop_canonical_upsert_message_fast', { request }),
  };
}

export function scopedCloudGroupCanonicalPersistence(accountId: string, organizationId?: string): CloudGroupCanonicalPersistence {
  const expectedBrowserScope = browserCanonicalScope(accountId, organizationId);
  return browserGroupCanonicalPersistence((command, args) => invokeDesktop(command, { ...args, expectedBrowserScope }));
}

export function captureCloudGroupCanonicalPersistence(): CloudGroupCanonicalPersistence {
  if (!isBrowserAppRuntime()) return nativePersistence;
  const session = cachedSessionSnapshot();
  if (!session) throw new Error('Sign in to Kordi to continue.');
  return scopedCloudGroupCanonicalPersistence(session.accountId, session.organizationId);
}
