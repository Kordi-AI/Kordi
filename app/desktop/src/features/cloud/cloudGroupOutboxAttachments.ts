import type {
  AttachmentItem,
} from '@/features/chat/composerController.types';
import type {
  SendCloudMessageAttachmentInput,
} from './authClient';
import {
  cloudGroupControlWithAttachmentReferences,
  parseCloudGroupControl,
} from './cloudGroupMessages';
import {
  CloudGroupOutbox,
  type CloudGroupOutboxAttachmentSource,
  type CloudGroupOutboxEntry,
} from './cloudGroupOutbox';

/** The send options a queued group message carries in its envelope. The first send and every
 * retry pass the same ones, so the durable send queue sees the same request each time. */
export function cloudGroupOutboxMessageOptions(envelope: string) {
  const message = parseCloudGroupControl(envelope)?.message;
  const voiceMessage = message?.voiceMessage?.mediaId
    ? { ...message.voiceMessage, mediaId: message.voiceMessage.mediaId }
    : null;
  return { messageKind: message?.messageKind, voiceMessage };
}

export function cloudGroupOutboxAttachmentSources(
  attachments: readonly AttachmentItem[],
): CloudGroupOutboxAttachmentSource[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    ...(attachment.livePhotoFiles ? { livePhotoFiles: attachment.livePhotoFiles } : {}),
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.subtype === 'sticker' ? { subtype: 'sticker' as const } : {}),
    formatLabel: attachment.formatLabel ?? null,
    mimeType: attachment.mimeType ?? null,
    ...(attachment.previewUrl?.startsWith('data:image/') ? {
      previewUrl: attachment.previewUrl,
    } : {}),
    sizeBytes: attachment.sizeBytes ?? null,
    widthPixels: attachment.widthPixels ?? null,
    heightPixels: attachment.heightPixels ?? null,
    ...(attachment.sourceAttachmentId ? { sourceAttachmentId: attachment.sourceAttachmentId } : {}),
  }));
}

export async function prepareCloudGroupOutboxEntryAttachments({
  outbox,
  entry,
  upload,
}: {
  outbox: CloudGroupOutbox;
  entry: CloudGroupOutboxEntry;
  upload: (
    attachments: CloudGroupOutboxAttachmentSource[],
  ) => Promise<SendCloudMessageAttachmentInput[]>;
}): Promise<CloudGroupOutboxEntry> {
  const pendingAttachments = entry.pendingAttachments ?? [];
  if (pendingAttachments.length === 0) return entry;
  const attachments = await upload(pendingAttachments);
  const envelope = cloudGroupControlWithAttachmentReferences(
    entry.envelope,
    attachments,
  );
  const prepared = await outbox.completeAttachmentUpload(
    entry.canonicalMessageId,
    { envelope, attachments },
  );
  if (!prepared) {
    throw new Error(
      'Cloud group outbox entry disappeared during attachment upload.',
    );
  }
  return prepared;
}
