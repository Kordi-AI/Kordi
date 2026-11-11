import type { DesktopCollaborationState } from '@/kordi-app/types';
import { chatSendQueuedForRetry } from '@/features/cloud/chatSendRetry';
import {
  isNativeAttachmentUploadAvailable,
  uploadNativeCloudAttachment,
} from '@/features/cloud/cloudAttachmentUpload';

import { isMp4VideoAttachment } from '../attachmentMediaGallery';
import type { AttachmentItem } from '../composerController.types';
import { markOptimisticCollaborationMessageFailed } from './optimistic';

export function prefetchNativeVideoRetry(attachments: AttachmentItem[]) {
  if (!isNativeAttachmentUploadAvailable()) return;
  for (const attachment of attachments.filter(isMp4VideoAttachment)) {
    void uploadNativeCloudAttachment({
      path: attachment.path,
      contentType: attachment.mimeType,
    }).catch(() => undefined);
  }
}

export function terminalCollaborationRetryFailure({
  error,
  conversationId,
  messageId,
}: {
  error: unknown;
  conversationId: string;
  messageId: string;
}) {
  // Timed out or lost its connection while still queued: the outbox sends it
  // again and the server returns the stored copy, so it stays "sending".
  if (chatSendQueuedForRetry(error)) return null;
  const detail = error instanceof Error ? error.message : 'Unable to retry message';
  return {
    detail,
    update: (current: DesktopCollaborationState | null) => (
      markOptimisticCollaborationMessageFailed(
        current,
        conversationId,
        messageId,
        detail,
      )
    ),
  };
}
