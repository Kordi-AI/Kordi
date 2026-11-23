import assert from 'node:assert/strict';

import type { CloudAccount, CloudMessage } from '../../src/features/cloud/authClient';
import { cloudMessageFromChatSync } from '../../src/features/cloud/chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMember, ChatSyncMessage } from '../../src/features/cloud/chatSyncTypes';
import { buildCloudDesktopCollaborationState } from '../../src/features/cloud/cloudCollaborationState';
import { cloudDeletedDirectConversation } from '../../src/features/cloud/cloudDeletedDirectCatalog';
import { buildCloudDeletedDirectChats, withCloudDeletedDirectChats } from '../../src/features/cloud/cloudDeletedDirectState';
import { buildCloudMessageIndex } from '../../src/features/cloud/cloudMessageIndex';
import { createCollaborationConversationMapper } from '../../src/features/collaboration/conversationProjectionCache';
import { cloudCollaborationConversationId } from '../../src/features/collaboration/conversationIds';
import type { Contact, Conversation } from '../../src/kordi-app/types';

/** Rowan keeps a direct chat with Maya after Maya's account was deleted. */
export const VIEWER = 'acct_rowan';
export const GONE = 'acct_maya';
export const STAND_IN = 'acct_kordi_deleted';
export const SESSION_ID = `session:direct-person:${GONE}:${VIEWER}`;
export const CLOSED_AT = '2026-11-18T10:00:00Z';
const CONVERSATION_ID = '019d0000-0000-7000-8000-0000000000a1';

export const viewerAccount: CloudAccount = {
  accountId: VIEWER,
  displayName: 'Rowan Sample',
  primaryEmail: 'rowan@example.test',
  avatarUrl: null,
  avatar: {
    entityType: 'human', entityId: VIEWER, source: 'generated', style: 'lorelei', seed: VIEWER,
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1,
    updatedAt: '2026-11-01T00:00:00Z',
  },
  nodeId: 'node_rowan',
  passwordSet: true,
};

export function syncMember(accountId: string, state: 'active' | 'left' | 'removed', overrides: Partial<ChatSyncMember> = {}): ChatSyncMember {
  return {
    account_id: accountId, role: 'member', membership_state: state, version: 1,
    last_delivered_sequence: 2, last_read_sequence: 2,
    joined_at: '2026-11-01T09:00:00Z', left_at: state === 'active' ? null : CLOSED_AT,
    ...overrides,
  };
}

export function keptDirectConversation(overrides: Partial<ChatSyncConversation> = {}): ChatSyncConversation {
  return {
    id: CONVERSATION_ID,
    kind: 'direct',
    shared_title: null,
    version: 5,
    created_by_account_id: VIEWER,
    legacy_session_id: SESSION_ID,
    latest_message_sequence: 2,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: CLOSED_AT,
    members: [syncMember(VIEWER, 'active', { role: 'owner' }), syncMember(STAND_IN, 'left', { display_name: 'Deleted account' })],
    closed: { closed_at: CLOSED_AT, closed_by_account_id: STAND_IN },
    preferences: { conversation_id: CONVERSATION_ID, account_id: VIEWER, personal_title: null, version: 1 },
    ...overrides,
  };
}

export function syncMessage(sequence: number, conversationId: string, sender: string, text: string): ChatSyncMessage {
  return {
    id: `019d0000-0000-7000-8000-00000000${String(100 + sequence).padStart(4, '0')}`,
    client_message_id: `019d0000-0000-7000-8000-00000001${String(100 + sequence).padStart(4, '0')}`,
    conversation_id: conversationId,
    conversation_sequence: sequence,
    sender_account_id: sender,
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 2,
    generation_status: null,
    provider_response_id: null,
    created_at: `2026-11-17T08:0${sequence}:00Z`,
    edited_at: null,
    deleted_at: null,
    reactions: [],
  };
}

/** Rowan's view of the kept chat, as the chat list and transcript receive it. */
export function keptChatViewModel(contacts: Contact[] = []): Conversation {
  const kept = keptDirectConversation();
  const messagesByPeer: Record<string, CloudMessage[]> = {};
  for (const snapshot of [syncMessage(1, kept.id, STAND_IN, 'See you at the station'), syncMessage(2, kept.id, VIEWER, 'Thanks, see you there')]) {
    const message = cloudMessageFromChatSync(snapshot, kept, VIEWER);
    const peer = message.fromAccountId === VIEWER ? message.toAccountId : message.fromAccountId;
    (messagesByPeer[peer] ??= []).push(message);
  }
  const messageIndex = buildCloudMessageIndex(VIEWER, messagesByPeer);
  const entry = cloudDeletedDirectConversation(kept, VIEWER);
  assert.ok(entry);
  const state = withCloudDeletedDirectChats(
    buildCloudDesktopCollaborationState({ account: viewerAccount, contacts, messagesByPeer, messageIndex }),
    buildCloudDeletedDirectChats({ account: viewerAccount, entries: [entry], messagesByPeer, messageIndex }),
  );
  const chat = state.conversations.find((conversation) => conversation.id === cloudCollaborationConversationId(GONE, 'person'));
  assert.ok(chat);
  return createCollaborationConversationMapper()(chat, state.hosts[0], 'Kordi');
}
