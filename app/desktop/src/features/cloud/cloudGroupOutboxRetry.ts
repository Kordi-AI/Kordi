import { chatSendRetryAfterMs, chatSendRetryDelayMs, isTransientChatSendError } from './chatSendRetry';
import type { CloudGroupOutboxEntry } from './cloudGroupOutbox';

/**
 * Attempts after which a recipient whose send keeps failing for a lasting
 * reason (a refusal, a bad payload, a local error) is marked failed: about
 * 53 seconds. A transient failure (offline, timed out, rate limited, a server
 * error) never counts toward it and keeps retrying, like a direct send.
 */
export const CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS = 6;

/**
 * Records one delivery round on `entry` in place: delivered recipients leave
 * the queue, failed ones wait for their next attempt.
 */
export function applyCloudGroupDeliveryRound(
  entry: CloudGroupOutboxEntry,
  recipientIds: readonly string[],
  outcomes: readonly PromiseSettledResult<unknown>[],
  nowMs: number,
): void {
  const delivered = new Set(entry.deliveredRecipientIds);
  const exhausted = new Set(entry.exhaustedRecipientIds ?? []);
  const pending = new Set(entry.pendingRecipientIds);
  let retryAfterMs = 0;
  outcomes.forEach((outcome, index) => {
    const recipientId = recipientIds[index];
    if (!recipientId) return;
    if (outcome.status === 'fulfilled') {
      pending.delete(recipientId);
      exhausted.delete(recipientId);
      delivered.add(recipientId);
      return;
    }
    const attempts = (entry.attemptsByRecipientId[recipientId] ?? 0) + 1;
    entry.attemptsByRecipientId[recipientId] = attempts;
    retryAfterMs = Math.max(retryAfterMs, chatSendRetryAfterMs(outcome.reason) ?? 0);
    if (!isTransientChatSendError(outcome.reason) && attempts >= CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS) {
      pending.delete(recipientId);
      exhausted.add(recipientId);
    }
  });
  entry.pendingRecipientIds = [...pending];
  entry.deliveredRecipientIds = [...delivered];
  entry.exhaustedRecipientIds = exhausted.size > 0 ? [...exhausted] : undefined;
  entry.awaitingCanonicalAck = entry.pendingRecipientIds.length === 0 && delivered.size > 0 && exhausted.size === 0;
  const retryDelays = entry.pendingRecipientIds.map((recipientId) => (
    chatSendRetryDelayMs(Math.max(1, entry.attemptsByRecipientId[recipientId] ?? 1))
  ));
  entry.nextAttemptAtMs = retryDelays.length > 0 ? nowMs + Math.max(Math.min(...retryDelays), retryAfterMs) : 0;
}
