import { KORDI_DELETED_ACCOUNT_ID } from '@/features/systemAgent/systemAgentIdentity';
import type { ChatSyncConversation } from './chatSyncTypes';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';

/** The newest member list this device has for one group conversation. */
export type CloudGroupMemberList = {
  version: number;
  /** Active members by account id, with their role. */
  active: ReadonlyMap<string, string>;
  createdByAccountId: string;
};

const listsByViewer = new Map<string, Map<string, CloudGroupMemberList>>();

/**
 * Keeps a group conversation's member list unless a newer one is already known, so lists
 * that arrive together or out of order settle on the latest.
 */
export function rememberCloudGroupMemberList(viewerAccountId: string, conversation: ChatSyncConversation): void {
  const viewer = viewerAccountId.trim();
  if (conversation.kind !== 'group' || !viewer) return;
  const sessionId = conversation.legacy_session_id?.trim() || conversation.id.trim();
  const lists = listsByViewer.get(viewer) ?? new Map<string, CloudGroupMemberList>();
  const known = lists.get(sessionId);
  if (known && known.version > conversation.version) return;
  lists.set(sessionId, {
    version: conversation.version,
    active: new Map(conversation.members
      .filter((member) => member.membership_state === 'active')
      .map((member) => [member.account_id, member.role])),
    createdByAccountId: conversation.created_by_account_id?.trim() ?? '',
  });
  listsByViewer.set(viewer, lists);
}

export function forgetCloudGroupMemberListsForTests(): void {
  listsByViewer.clear();
}

export function latestCloudGroupMemberList(viewerAccountId: string, sessionId: string): CloudGroupMemberList | null {
  return listsByViewer.get(viewerAccountId.trim())?.get(sessionId.trim()) ?? null;
}

/** Whether a group row may count `accountId` as a member: never the stand-in, and only an active member of the newest list. */
export function cloudGroupRowMayCount(latest: CloudGroupMemberList | null, viewerAccountId: string, accountId: string): boolean {
  if (accountId === KORDI_DELETED_ACCOUNT_ID) return false;
  return !latest || accountId === viewerAccountId || latest.active.has(accountId);
}

/**
 * Leaves only the people a group row may count as members, so a row written against an
 * older member list, or a stale copy, adds no one back.
 */
export function pruneCloudGroupRowMembers(
  latest: CloudGroupMemberList | null,
  viewerAccountId: string,
  participantByAccount: Map<string, unknown>,
): void {
  for (const accountId of [...participantByAccount.keys()]) {
    if (!cloudGroupRowMayCount(latest, viewerAccountId, accountId)) participantByAccount.delete(accountId);
  }
}

/**
 * Whether a group's stored creator still holds it. Once the creator's account is deleted the
 * server names the stand-in as creator, and the current owner takes the group: the stored
 * creator, no longer a member, is not added back. Rows that do not carry the server's creator
 * and roles hand nothing over unless this device has a member list for the group.
 */
export function cloudGroupCreatorHandover(input: {
  storedCreatorIdentityId: string;
  envelope: Pick<CloudGroupControlEnvelope, 'createdByAccountId' | 'participants'>;
  fromServer: boolean;
  latest: CloudGroupMemberList | null;
  isMember: (accountId: string) => boolean;
}): { storedCreatorGone: boolean; ownerAccountId: string } {
  const stored = input.storedCreatorIdentityId;
  const createdBy = input.latest?.createdByAccountId || (input.fromServer ? input.envelope.createdByAccountId : '');
  const creatorDeleted = createdBy === KORDI_DELETED_ACCOUNT_ID;
  const storedAccountId = /^human:acct_/.test(stored) ? stored.slice('human:'.length) : '';
  const storedCreatorGone = storedAccountId === KORDI_DELETED_ACCOUNT_ID
    || (creatorDeleted && Boolean(storedAccountId) && !input.isMember(storedAccountId));
  const owner = (participants: Iterable<[string, string | null | undefined]>) => [...participants]
    .find(([accountId, role]) => role === 'owner' && accountId !== KORDI_DELETED_ACCOUNT_ID)?.[0];
  const ownerAccountId = creatorDeleted || storedCreatorGone
    ? (input.latest ? owner(input.latest.active) : undefined)
      ?? (input.fromServer ? owner(input.envelope.participants.map((participant) => [participant.accountId, participant.role])) : undefined)
      ?? ''
    : '';
  return { storedCreatorGone, ownerAccountId };
}
