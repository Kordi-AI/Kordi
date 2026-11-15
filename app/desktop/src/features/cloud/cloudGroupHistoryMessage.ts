import type { Message } from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import { cloudMessageAttachmentToMessageAttachment } from './cloudAttachments';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';
import type { ChatSyncMessage } from './chatSyncTypes';

export type CloudGroupHistoryRow = {
  wire: CloudMessage;
  envelope: CloudGroupControlEnvelope;
  snapshot: ChatSyncMessage;
};

/** The transcript row of one group history message, read straight from its server envelope. */
export function cloudGroupHistoryMessage(
  row: CloudGroupHistoryRow,
  accountId: string | null,
  id = row.envelope.message?.id ?? row.snapshot.id,
): Message | null {
  const message = row.envelope.message;
  if (!message) return null;
  return {
    id,
    entryId: message.id,
    reactionTargetMessageId: row.snapshot.id,
    role: message.senderAccountId === accountId ? 'user' : 'person',
    sender: message.senderDisplayName ?? row.envelope.actor.displayName,
    text: message.text,
    time: '',
    timestampMs: message.createdAtMs,
    attachments: row.wire.attachments?.map(cloudMessageAttachmentToMessageAttachment),
  };
}
