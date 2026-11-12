import { livePhotoAttachmentIds } from '@/features/chat/livePhotos';
import type { CloudMessage, SendCloudMessageOptions } from './authClient';
import { cloudMessageFromChatSync, cloudOperationUuid, groupMemberAccountIdsFromEnvelope, chatTextContent } from './chatSyncMapping';
import { ChatSyncState } from './chatSyncState';
import type { ChatSyncMessage } from './chatSyncTypes';
import { isRetryableCloudDeliveryError } from './cloudAuthError';
import { completeChatSyncOutbox, dueChatSyncOutbox, enqueueChatSyncOutbox, failChatSyncOutbox } from '@/lib/desktopChatSync';
import { captureChatDeliveryScope, type ChatDeliveryScope } from './chatDeliveryScope';
import { chatSendRetryAfterMs, chatSendRetryGate, markChatSendQueuedForRetry, type ChatSendRetryGate } from './chatSendRetry';

const durableOutbox = {
  enqueue: enqueueChatSyncOutbox, due: dueChatSyncOutbox, complete: completeChatSyncOutbox, fail: failChatSyncOutbox,
};

// Send and drain use separate wrappers around the same client state. A freshly
// enqueued operation is already due, but its original request still owns it.
const inFlightSends = new WeakMap<ChatSyncState, Map<string, number>>();
function activeSends(state: ChatSyncState): Map<string, number> {
  let active = inFlightSends.get(state);
  if (!active) {
    active = new Map();
    inFlightSends.set(state, active);
  }
  return active;
}
const sendKey = (accountId: string, organizationId: string | null | undefined, operationId: string) => (
  JSON.stringify([accountId.trim(), organizationId ?? null, operationId])
);

export class ChatSyncMessageDelivery {
  constructor(
    private readonly state: ChatSyncState,
    private readonly outbox = durableOutbox,
    private readonly retryGate: ChatSendRetryGate = chatSendRetryGate,
  ) {}

  async sendMessage(
    token: string,
    peerAccountId: string,
    body: string,
    options: SendCloudMessageOptions = {},
    capturedScope?: ChatDeliveryScope,
  ): Promise<CloudMessage> {
    const attachments = options.attachments ?? [];
    // An empty text message is never meant to be seen; the server refuses it too.
    if (!body.trim() && attachments.length === 0 && !options.voiceMessage) throw new Error('Empty message.');
    const sessionId = options.sessionId?.trim() ?? '';
    const conversationKind = options.conversationKind
      ?? (body.startsWith('kordi-cloud-group:') ? 'group' : undefined);
    const envelopeMemberAccountIds = conversationKind === 'group'
      ? groupMemberAccountIdsFromEnvelope(body)
      : null;
    const conversationMemberAccountIds = envelopeMemberAccountIds ?? options.memberAccountIds;
    const accountId = options.accountId?.trim() || this.state.activeAccountId?.trim() || '';
    const deliveryScope = capturedScope ?? captureChatDeliveryScope(token, accountId);
    deliveryScope.assertCurrent();
    const stableGroupSession = sessionId || `${accountId}:${[...(options.memberAccountIds ?? [])].sort().join(':')}`;
    const clientMessageId = cloudOperationUuid(
      conversationKind === 'group'
        ? options.clientMessageId?.trim() || `group-message:${stableGroupSession}:${body}`
        : options.clientMessageId,
    );
    const messageKind = options.messageKind?.trim() || 'text';
    const historyLocalMessageId =
      options.canonicalHistoryLocalMessageId?.trim() ?? '';
    const historyCreatedAt = options.clientCreatedAt?.trim() ?? '';
    const canonicalHistory = messageKind.startsWith('canonical-history-')
      && historyLocalMessageId
      && Number.isFinite(Date.parse(historyCreatedAt))
      ? {
          localMessageId: historyLocalMessageId,
          originalCreatedAt: new Date(historyCreatedAt).toISOString(),
        }
      : null;
    const durableOptions: SendCloudMessageOptions = {
      ...options,
      accountId: accountId || options.accountId,
      clientMessageId,
      conversationKind,
      memberAccountIds: conversationMemberAccountIds,
    };
    const durablePeerAccountId = conversationKind === 'group'
      ? [...new Set(options.memberAccountIds ?? [])].map((value) => value.trim()).filter(Boolean).sort()[0]
        ?? peerAccountId.trim()
      : peerAccountId.trim();
    const durable = Boolean(accountId) && !options.transient;
    const active = activeSends(this.state);
    const key = sendKey(accountId, deliveryScope.expectedOrganizationId, clientMessageId);
    if (durable) active.set(key, (active.get(key) ?? 0) + 1);
    try {
      if (durable) {
        await this.outbox.enqueue(accountId, clientMessageId, {
          peerAccountId: durablePeerAccountId,
          body,
          options: durableOptions,
        }, deliveryScope.expectedOrganizationId);
      }
      deliveryScope.assertCurrent();
      const conversation = await this.state.ensureConversation(token, {
        peerAccountId,
        sessionId,
        kind: conversationKind,
        memberAccountIds: conversationMemberAccountIds,
        sharedTitle: options.sharedTitle,
        sourceGroupSpaceId: options.sourceGroupSpaceId,
        accountId,
        replaceMembers: envelopeMemberAccountIds !== null,
      });
      deliveryScope.assertCurrent();
      const response = await this.state.send<{ message: ChatSyncMessage }>(
        `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...deliveryScope.headers },
          body: JSON.stringify({
            client_message_id: clientMessageId,
            kind: messageKind,
            content: chatTextContent(
              body,
              attachments,
              canonicalHistory,
              options.voiceMessage,
            ),
            reply_to_message_id: null,
            attachment_ids: [...new Set(attachments.flatMap(livePhotoAttachmentIds))],
          }),
        },
        'Could not send message.',
      );
      deliveryScope.assertCurrent();
      if (!response?.message) throw new Error('Empty response from chat sync server.');
      this.state.retainMessages([response.message]);
      const advancedConversation = {
        ...conversation,
        version: conversation.version + 1,
        latest_message_sequence: Math.max(
          conversation.latest_message_sequence,
          response.message.conversation_sequence,
        ),
      };
      this.state.rememberConversation(advancedConversation);
      if (durable) await this.outbox.complete(accountId, clientMessageId, deliveryScope.expectedOrganizationId);
      return cloudMessageFromChatSync(
        response.message,
        advancedConversation,
        accountId || conversation.preferences.account_id,
      );
    } catch (error) {
      deliveryScope.assertCurrent();
      const retryAfterMs = chatSendRetryAfterMs(error);
      if (retryAfterMs !== null && accountId) this.retryGate.hold(accountId, retryAfterMs);
      if (durable) {
        // A transient failure stays pending: the server may have stored the
        // message, and a repeat with the same client message id returns it.
        const retryable = isRetryableCloudDeliveryError(error);
        await this.outbox.fail(
          accountId,
          clientMessageId,
          error instanceof Error ? error.message : 'Reliable chat send failed.',
          retryable,
          deliveryScope.expectedOrganizationId,
        ).catch(() => {});
        if (retryable) markChatSendQueuedForRetry(error);
      }
      throw error;
    } finally {
      if (durable) {
        const remaining = (active.get(key) ?? 1) - 1;
        if (remaining > 0) active.set(key, remaining);
        else active.delete(key);
      }
    }
  }

  async drainChatOutbox(token: string, accountId: string): Promise<CloudMessage[]> {
    const deliveryScope = captureChatDeliveryScope(token, accountId);
    this.state.activeAccountId = accountId.trim() || this.state.activeAccountId;
    // The server asked for a pause (Retry-After); queued sends wait it out.
    if (this.retryGate.remainingMs(accountId.trim()) > 0) return [];
    const active = activeSends(this.state);
    // A storage read can return an old pending snapshot after a send completes.
    const activeAtRead = new Set(active.keys());
    const pending = await this.outbox.due(accountId, deliveryScope.expectedOrganizationId);
    const delivered: CloudMessage[] = [];
    deliveryScope.assertCurrent();
    for (const operation of pending) {
      deliveryScope.assertCurrent();
      if (this.retryGate.remainingMs(accountId.trim()) > 0) break;
      const key = sendKey(accountId, deliveryScope.expectedOrganizationId, operation.operationId);
      if (activeAtRead.has(key) || active.has(key)) continue;
      const payload = operation.payload;
      if (!payload?.peerAccountId || typeof payload.body !== 'string') {
        await this.outbox.fail(
          accountId,
          operation.operationId,
          'Stored reliable chat operation is invalid.',
          false,
          deliveryScope.expectedOrganizationId,
        );
        continue;
      }
      try {
        delivered.push(await this.sendMessage(
          token,
          payload.peerAccountId,
          payload.body,
          {
            ...(payload.options as SendCloudMessageOptions),
            accountId,
            clientMessageId: operation.operationId,
          },
          deliveryScope,
        ));
      } catch {
        deliveryScope.assertCurrent();
        // sendMessage records retry classification and backoff atomically.
      }
    }
    return delivered;
  }

}
