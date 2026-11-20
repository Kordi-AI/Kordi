import type { Dispatch, SetStateAction } from 'react';

import { isBuiltInAccountId } from '@/features/systemAgent/systemAgentIdentity';
import type { CanonicalIdentity, CanonicalSessionState } from '@/kordi-app/types';
import type { ChatSyncConversation } from './chatSyncTypes';
import { captureCloudGroupCanonicalPersistence, type CloudGroupCanonicalPersistence } from './cloudGroupCanonicalPersistence';

function identityAccountId(identity: CanonicalIdentity) {
  const accountId = identity.humanId?.trim() || identity.sourceIdentityId?.trim() || '';
  return accountId.startsWith('acct_') ? accountId : '';
}

function isCloudGroupAgent(identity: CanonicalIdentity) {
  const metadata = identity.metadata;
  return Boolean(metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).cloudGroupAgent === true);
}

export function cloudGroupConversationSessionId(conversation: Pick<ChatSyncConversation, 'id' | 'legacy_session_id'>) {
  return conversation.legacy_session_id?.trim() || conversation.id.trim();
}

/**
 * Who a group session still counts as a member although its conversation no longer lists
 * them as active: a person who left or was removed while no leave notice reached this
 * device, or a deleted account, whose member row the server drops without one. Their
 * group agents go with them. The member list replaces what this device had, as a fresh
 * bootstrap would, but only for members it had before the list was written: one added
 * here since then is not yet on an older list.
 */
export function cloudGroupDepartedParticipantIdentityIds(
  state: CanonicalSessionState | null,
  conversation: ChatSyncConversation,
  viewerAccountId: string,
): string[] {
  if (!state || conversation.kind !== 'group') return [];
  const active = new Set(conversation.members
    .filter((member) => member.membership_state === 'active')
    .map((member) => member.account_id));
  // A list without the viewer belongs to a conversation the viewer lost; its removal handles it.
  const writtenAtMs = Date.parse(conversation.updated_at);
  if (!active.has(viewerAccountId) || !Number.isFinite(writtenAtMs)) return [];
  const sessionId = cloudGroupConversationSessionId(conversation);
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  const rows = state.participants.filter((row) => (
    row.sessionId === sessionId && row.state === 'active' && row.addedAtMs < writtenAtMs
  ));
  const departedAccountIds = new Set<string>();
  const departed: string[] = [];
  for (const row of rows) {
    const identity = identityById.get(row.identityId);
    if (identity?.kind !== 'human' || row.identityId === state.profile.humanIdentityId) continue;
    const accountId = identityAccountId(identity);
    if (!accountId || accountId === viewerAccountId || isBuiltInAccountId(accountId) || active.has(accountId)) continue;
    departedAccountIds.add(accountId);
    departed.push(row.identityId);
  }
  for (const row of rows) {
    const identity = identityById.get(row.identityId);
    if (identity?.kind === 'agent' && isCloudGroupAgent(identity)
      && departedAccountIds.has(identity.humanId?.trim() ?? '')) departed.push(row.identityId);
  }
  return departed;
}

/**
 * Takes the departed members out of a group session, here and in the local store. A store
 * that refuses one (a desktop keeps a group's creator and last admin) keeps it until a later
 * member list tries again. Returns the identities removed.
 */
export async function removeDepartedCloudGroupParticipants(input: {
  conversation: ChatSyncConversation;
  viewerAccountId: string;
  getState(): CanonicalSessionState | null;
  setState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  persistence?: Pick<CloudGroupCanonicalPersistence, 'removeCanonicalSessionParticipant'>;
}): Promise<string[]> {
  const identityIds = cloudGroupDepartedParticipantIdentityIds(input.getState(), input.conversation, input.viewerAccountId);
  if (identityIds.length === 0) return [];
  const persistence = input.persistence ?? captureCloudGroupCanonicalPersistence();
  const sessionId = cloudGroupConversationSessionId(input.conversation);
  const removed: string[] = [];
  for (const identityId of identityIds) {
    try {
      await persistence.removeCanonicalSessionParticipant({ sessionId, identityId, removedByIdentityId: null });
      removed.push(identityId);
    } catch {
      // Kept until the next member list; the rest still go.
    }
  }
  if (removed.length === 0) return removed;
  const gone = new Set(removed);
  input.setState((current) => current && {
    ...current,
    participants: current.participants.map((row) => (
      row.sessionId === sessionId && row.state === 'active' && gone.has(row.identityId) ? { ...row, state: 'left' } : row
    )),
  });
  return removed;
}
