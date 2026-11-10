import type { AttachmentImageDeliveryVisual } from './transcriptAttachmentTypes';

export function attachmentImageDeliveryVisual(
  status?: string | null,
  uploadFailure?: string | null,
): AttachmentImageDeliveryVisual | null {
  if (uploadFailure?.trim()) return { kind: 'failed', label: uploadFailure.trim() };
  const normalized = status?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (normalized === 'sending' || normalized === 'pending' || normalized === 'pending_send') {
    return { kind: 'uploading', label: 'Sending image' };
  }
  if (normalized === 'processing' || normalized === 'awaiting_reply') {
    return { kind: 'delivering', label: 'Delivering image' };
  }
  // There is no separate delivered state: the server having the image is Sent.
  if (normalized === 'sent' || normalized === 'delivered') return { kind: 'sent', label: 'Sent' };
  if (normalized === 'read' || normalized === 'responded') return { kind: 'read', label: 'Read' };
  if (normalized === 'partial') return { kind: 'partial', label: 'Partially delivered' };
  if (normalized === 'failed' || normalized === 'processing_failed' || normalized === 'cancelled') {
    return { kind: 'failed', label: 'Sending failed' };
  }
  return null;
}
