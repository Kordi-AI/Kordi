import { collaborationMessageSourceId } from '@/features/collaboration/legacyBridgeCompatibility';
import type { Message } from '@/kordi-app/types';

export type PinnedMessageScope = 'private' | 'shared';

export type PinnedMessageItem = {
  message: Message;
  scope: PinnedMessageScope;
};

export function chatMessageActionId(message: Message) {
  return (
    message.id?.trim()
    || message.entryId?.trim()
    || message.turn?.id?.trim()
    || ''
  );
}

export function stableCloudPinMessageId(
  message: Message,
  conversationId: string,
) {
  const actionId = chatMessageActionId(message);
  const groupWireId = message.reactionConversationId?.startsWith('session:group:') ? message.reactionTargetMessageId?.trim() : null;
  return groupWireId || collaborationMessageSourceId(actionId, conversationId) || actionId;
}

export function pinnedMessageCandidateIds(
  message: Message,
  conversationId: string,
) {
  return [
    ...new Set(
      [
        chatMessageActionId(message),
        stableCloudPinMessageId(message, conversationId),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
