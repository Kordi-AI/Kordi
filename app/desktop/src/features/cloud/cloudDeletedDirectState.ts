import type { DeletedPeerAccountMark } from '@/features/collaboration/deletedAccountPresentation';
import { KORDI_DELETED_ACCOUNT_ID, KORDI_DELETED_ACCOUNT_NAME } from '@/features/systemAgent/systemAgentIdentity';
import type {
  Contact,
  DesktopChatTurnSnapshot,
  DesktopCollaborationConversation,
  DesktopCollaborationState,
} from '@/kordi-app/types';

import type { CloudAccount, CloudMessage } from './authClient';
import {
  cloudDirectPersonMessagesForPeer,
  cloudGroupControlMessageIds,
  cloudReadIdsRevision,
  cloudTurnRevision,
} from './cloudCollaborationMemo';
import { buildCloudCollaborationConversation } from './cloudCollaborationState';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import { CLOUD_PERSON_RUNTIME } from './cloudContactPeers';
import type { CloudDeletedDirectConversation } from './cloudDeletedDirectCatalog';
import type { CloudGroupReadCursor } from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';

export type CloudDeletedDirectChat = DesktopCollaborationConversation & DeletedPeerAccountMark;

/**
 * The stand-in a kept chat names instead of the deleted person. It only feeds
 * that chat: it is never a contact, so no picker, mention list or contact page
 * lists it.
 */
export function deletedAccountChatContact(peerAccountId: string): Contact {
  return {
    id: `cloud:${peerAccountId}`,
    name: KORDI_DELETED_ACCOUNT_NAME,
    initials: '',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: '',
    collaborationSources: [CLOUD_HOST_SENTINEL],
    status: 'offline',
    discoverableOn: [],
    detail: '',
    owner: KORDI_DELETED_ACCOUNT_NAME,
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceParticipantId: peerAccountId,
    sourceRuntime: CLOUD_PERSON_RUNTIME,
    sourceHumanId: peerAccountId,
    contactStatus: 'deleted',
    contactRequestDirection: null,
    avatarSeed: KORDI_DELETED_ACCOUNT_ID,
    profileImageUrl: null,
  };
}

// The last chat built from each message list, so an unchanged chat keeps its object.
const chatCache = new WeakMap<readonly CloudMessage[], { key: string; chat: CloudDeletedDirectChat }>();

/**
 * The person chats of kept direct conversations, built like a contact's chat:
 * same id and session id as before the deletion, history from the synced
 * messages, named and drawn as the Deleted account.
 */
export function buildCloudDeletedDirectChats({
  account,
  entries,
  messagesByPeer,
  messageIndex,
  readInboundMessageIdsByPeer = {},
  readCursorsBySessionId = {},
  localAgentTurnsByRequestId = {},
  hiddenSessionIds = new Set<string>(),
}: {
  account: CloudAccount;
  entries: readonly CloudDeletedDirectConversation[];
  messagesByPeer: Record<string, CloudMessage[]>;
  messageIndex: CloudMessageIndex;
  readInboundMessageIdsByPeer?: Record<string, Set<string>>;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  localAgentTurnsByRequestId?: Record<string, DesktopChatTurnSnapshot>;
  hiddenSessionIds?: ReadonlySet<string>;
}): CloudDeletedDirectChat[] {
  return entries.flatMap((entry) => {
    if (hiddenSessionIds.has(entry.sessionId) || entry.peerAccountId === account.accountId) return [];
    const peerId = entry.peerAccountId;
    const peerMessages = messagesByPeer[peerId] ?? messageIndex.byPeerId.get(peerId) ?? [];
    const messages = cloudDirectPersonMessagesForPeer(account, peerId, peerMessages);
    // As for a contact's chat, a chat with nothing synced yet is not listed.
    if (messages.length === 0) return [];
    const readCursor = readCursorsBySessionId[entry.sessionId];
    const readIds = readInboundMessageIdsByPeer[peerId];
    const key = [
      account.accountId, account.displayName ?? '', account.primaryEmail, account.nodeId ?? '',
      peerId, entry.sessionId, entry.closedAt,
      readCursor?.lastReadMessageId ?? '', readCursor?.lastReadCreatedAtMs ?? '',
      readIds ? cloudReadIdsRevision(readIds) : '',
      cloudTurnRevision(messages, localAgentTurnsByRequestId),
    ].join('\u0000');
    const cached = chatCache.get(messages);
    if (cached?.key === key) return [cached.chat];
    const chat: CloudDeletedDirectChat = {
      ...buildCloudCollaborationConversation({
        account,
        contact: deletedAccountChatContact(peerId),
        messages,
        runtime: CLOUD_PERSON_RUNTIME,
        readInboundMessageIds: readIds,
        readCursorsBySessionId,
        localAgentTurnsByRequestId,
        groupControlMessageIds: cloudGroupControlMessageIds(messageIndex),
      }),
      peerAccountDeletedAt: entry.closedAt,
    };
    chatCache.set(messages, { key, chat });
    return [chat];
  });
}

/**
 * Puts kept chats in their place by recency. Each replaces a chat built for the
 * same account from a contact entry that has not been removed yet.
 */
export function withCloudDeletedDirectChats(
  state: DesktopCollaborationState,
  chats: readonly CloudDeletedDirectChat[],
): DesktopCollaborationState {
  if (chats.length === 0) return state;
  const ids = new Set(chats.map((chat) => chat.id));
  const conversations = [...state.conversations.filter((conversation) => !ids.has(conversation.id)), ...chats]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return { ...state, conversations };
}
