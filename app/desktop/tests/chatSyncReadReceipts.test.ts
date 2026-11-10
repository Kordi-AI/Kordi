import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSync';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { ChatSyncConversationClient } from '../src/features/cloud/chatSyncConversationClient';
import {
  applyChatSyncCursorEvent,
  chatSyncCursorEventTouches,
  chatSyncOwnMessagesReadThrough,
  chatSyncReadOutboxFromPayload,
  ChatDeliveryAcknowledgements,
  withChatSyncReadOutbox,
} from '../src/features/cloud/chatSyncReadReceipts';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncEvent, ChatSyncMember } from '../src/features/cloud/chatSyncTypes';

// Synthetic accounts and conversations only.
function member(accountId: string, read: number, extra: Partial<ChatSyncMember> = {}): ChatSyncMember {
  return {
    account_id: accountId, role: 'member', membership_state: 'active', version: 1,
    last_delivered_sequence: read, last_read_sequence: read,
    joined_at: '2026-11-01T10:00:00Z', left_at: null, ...extra,
  };
}

function groupConversation(members: ChatSyncMember[], latest = 10): ChatSyncConversation {
  return {
    id: 'conversation:receipts', kind: 'group', shared_title: 'Launch prep', version: 1,
    created_by_account_id: 'acct_me', legacy_session_id: 'session:group:receipts',
    latest_message_sequence: latest, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z',
    members,
    preferences: { conversation_id: 'conversation:receipts', account_id: 'acct_me', personal_title: null, version: 1 },
  };
}

function message(sequence: number, sender = 'acct_me', conversationId = 'conversation:receipts'): ChatSyncMessage {
  return {
    id: `message:${sequence}`, client_message_id: `client:${sequence}`, conversation_id: conversationId,
    conversation_sequence: sequence, sender_account_id: sender, kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: `hello ${sequence}` }] },
    reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null,
    provider_response_id: null, created_at: '2026-11-01T10:01:00Z', edited_at: null, deleted_at: null,
  };
}

function cursorEvent(conversationId: string, payload: Record<string, unknown>, streamSeq = 20): ChatSyncEvent {
  return {
    stream_seq: streamSeq, event_id: `event:${streamSeq}`, protocol_version: 2, type: 'read_cursor.updated',
    critical: true, conversation_id: conversationId, entity_id: null, entity_version: null,
    occurred_at: '2026-11-01T10:05:00Z', payload,
  };
}

test('two ticks follow the read watermark even when no reader cursor is known', () => {
  const conversation = groupConversation([
    member('acct_me', 10, { read_outbox_sequence: 7 }),
    member('acct_maya', 2),
    member('acct_omar', 3),
  ]);

  assert.equal(chatSyncOwnMessagesReadThrough(conversation, 'acct_me'), 7);
  assert.ok(cloudMessageFromChatSync(message(7), conversation, 'acct_me').readAt);
  assert.equal(cloudMessageFromChatSync(message(8), conversation, 'acct_me').readAt, null);
});

test('without a watermark the highest other read cursor marks own messages read (older servers)', () => {
  const conversation = groupConversation([
    member('acct_me', 10),
    member('acct_maya', 4),
    member('acct_omar', 6),
    member('acct_left', 9, { membership_state: 'left' }),
  ]);

  assert.equal(chatSyncOwnMessagesReadThrough(conversation, 'acct_me'), 6);
  assert.ok(cloudMessageFromChatSync(message(6), conversation, 'acct_me').readAt);
  assert.equal(cloudMessageFromChatSync(message(7), conversation, 'acct_me').readAt, null);
  // The rule takes the larger of the two sources.
  const withLowerWatermark = withChatSyncReadOutbox(conversation, 5);
  assert.equal(chatSyncOwnMessagesReadThrough(withLowerWatermark, 'acct_me'), 6);
});

test('a camelCase watermark from the member snapshot is understood too', () => {
  const viewer = { ...member('acct_me', 10), readOutboxSequence: 8 } as ChatSyncMember;
  const conversation = groupConversation([viewer, member('acct_maya', 1)]);

  assert.equal(chatSyncOwnMessagesReadThrough(conversation, 'acct_me'), 8);
});

test('the watermark from read_cursor.updated only ever rises', () => {
  const conversation = groupConversation([member('acct_me', 10, { read_outbox_sequence: 6 }), member('acct_maya', 2)]);
  const raised = applyChatSyncCursorEvent(conversation, {
    cursor: { account_id: 'acct_maya', last_delivered_sequence: 9, last_read_sequence: 9 },
    read_outbox: { conversation_id: conversation.id, sequence: 9 },
  });
  assert.ok(raised);
  assert.equal(raised.conversation.members[0]?.read_outbox_sequence, 9);
  assert.equal(raised.conversation.members[1]?.last_read_sequence, 9);

  const lower = applyChatSyncCursorEvent(raised.conversation, { readOutbox: { conversationId: conversation.id, sequence: 4 } });
  assert.equal(lower, null);
  assert.equal(withChatSyncReadOutbox(raised.conversation, 3), raised.conversation);
  assert.equal(chatSyncReadOutboxFromPayload({ read_outbox: { conversation_id: 'conversation:other', sequence: 12 } }, conversation.id), null);
  assert.equal(chatSyncReadOutboxFromPayload({ cursor: {} }, conversation.id), null);
});

test('the watermark applies even when the reader is not a member the app knows', () => {
  const conversation = groupConversation([member('acct_me', 10), member('acct_maya', 1)]);
  const applied = applyChatSyncCursorEvent(conversation, {
    cursor: { account_id: 'acct_unknown', last_delivered_sequence: 8, last_read_sequence: 8 },
    read_outbox: { conversation_id: conversation.id, sequence: 8 },
  });

  assert.ok(applied);
  assert.equal(chatSyncOwnMessagesReadThrough(applied.conversation, 'acct_me'), 8);
  assert.equal(chatSyncCursorEventTouches(applied, message(5)), true);
  assert.equal(chatSyncCursorEventTouches(applied, message(5, 'acct_maya')), false, 'the watermark only covers own messages');
  assert.equal(chatSyncCursorEventTouches(applied, message(9)), false);
});

test('sync turns a watermark event into upserts that show own messages as read', async () => {
  const conversation = groupConversation([member('acct_me', 10, { read_outbox_sequence: 2 }), member('acct_maya', 2)]);
  const state = new ChatSyncState(
    async () => ({
      protocol_version: 2,
      events: [cursorEvent(conversation.id, {
        cursor: { account_id: 'acct_maya', last_delivered_sequence: 2, last_read_sequence: 2 },
        read_outbox: { conversation_id: conversation.id, sequence: 4 },
      })],
      next_cursor: '20', last_stream_seq: 20, has_more: false, server_time: '2026-11-01T10:05:00Z',
    }) as never,
    () => 'acct_me',
    () => undefined,
    () => null,
  );
  state.rememberConversation(conversation);
  state.retainMessages([message(3), message(4), message(5), message(4, 'acct_maya', conversation.id)].map((value, index) => (
    index === 3 ? { ...value, id: 'message:peer-4' } : value
  )));
  const result = await new ChatSyncSyncClient(state).syncCloudEvents('token', '19');
  const upserts = result.events.filter((event) => event.eventType === 'message.upsert');

  assert.deepEqual(upserts.map((event) => event.messageId).sort(), ['message:3', 'message:4']);
  for (const event of upserts) {
    assert.ok((event.payload as { message: { readAt: string | null } }).message.readAt);
  }
  assert.equal(state.conversationById.get(conversation.id)?.members[0]?.read_outbox_sequence, 4);
});

test('a read own group message is read in the delivery summary without a known reader', () => {
  const conversation = groupConversation([member('acct_me', 10, { read_outbox_sequence: 8 }), member('acct_maya', 1)]);
  const body = encodeCloudGroupControl({
    kind: 'group-message', groupId: conversation.legacy_session_id!, groupTitle: 'Launch prep',
    createdByAccountId: 'acct_me', actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null },
    participants: conversation.members.map((value) => ({ accountId: value.account_id, displayName: value.account_id, avatarUrl: null })),
    message: { id: 'message:8', senderAccountId: 'acct_me', senderKind: 'human', senderDisplayName: 'Me', text: 'hello', createdAtMs: Date.parse('2026-11-01T10:01:00Z') },
  });
  const mapped = cloudMessageFromChatSync({ ...message(8), content: { schema: 1, blocks: [{ type: 'text', text: body }] } }, conversation, 'acct_me');
  const messagesByPeer = applyCloudSyncEventsToMessagesByPeer('acct_me', {}, [{
    eventId: 'event:watermark', eventType: 'message.upsert', peerAccountId: 'acct_maya',
    messageId: mapped.messageId, payload: { message: mapped }, occurredAt: '2026-11-01T10:01:00Z',
  }]);
  const summary = buildCloudMessageIndex('acct_me', messagesByPeer).deliveryByMessageId.get('message:8');

  assert.deepEqual(mapped.readByAccountIds, []);
  assert.equal(summary?.state, 'read');
});

test('delivery acknowledgements are sent only when the own delivered cursor advances', async () => {
  const sent: Array<{ path: string; sequence: number }> = [];
  let fail = false;
  const conversation = groupConversation([
    { ...member('acct_me', 3), last_delivered_sequence: 5, last_read_sequence: 3 },
    member('acct_maya', 1),
  ]);
  const state = new ChatSyncState(
    async (path, init) => {
      if (fail) throw new Error('offline');
      sent.push({ path, sequence: (JSON.parse(String(init.body)) as { sequence: number }).sequence });
      return undefined as never;
    },
    () => 'acct_me',
    () => undefined,
    () => null,
  );
  state.rememberConversation(conversation);
  const client = new ChatSyncConversationClient(state);

  await client.acknowledgeChatDelivery('token', conversation.id, 5);
  assert.equal(sent.length, 0, 'already delivered');
  await client.acknowledgeChatDelivery('token', conversation.id, 7);
  await client.acknowledgeChatDelivery('token', conversation.id, 7);
  await client.acknowledgeChatDelivery('token', conversation.id, 6);
  assert.deepEqual(sent, [{ path: `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/delivered`, sequence: 7 }]);

  fail = true;
  await assert.rejects(client.acknowledgeChatDelivery('token', conversation.id, 8));
  fail = false;
  await client.acknowledgeChatDelivery('token', conversation.id, 8);
  assert.deepEqual(sent.map((value) => value.sequence), [7, 8], 'a failed acknowledgement is retried');
});

test('an own read cursor already covers delivery', () => {
  const acknowledgements = new ChatDeliveryAcknowledgements();
  const conversation = groupConversation([{ ...member('acct_me', 9), last_delivered_sequence: 2 }]);

  assert.equal(acknowledgements.claim(conversation, 9), null);
  assert.ok(acknowledgements.claim(conversation, 10));
});
